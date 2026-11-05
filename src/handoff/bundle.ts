import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readDesignFiles } from "../generation/context.ts";
import { designOids } from "../generation/oids.ts";
import { ExportError, exportFolder, exportPage } from "../export/html.ts";
import { renderPngs } from "../export/render.ts";
import type { ZipEntry } from "../export/zip.ts";
import { readChat } from "../workspace/chat.ts";
import { readComments } from "../workspace/comments.ts";
import { activeDesignSystem } from "../workspace/design-systems.ts";
import { readLayout } from "../workspace/layout.ts";
import type { Frame } from "../workspace/frames.ts";
import { designDir, designPages, listProjects } from "../workspace/paths.ts";
import template from "./template-v1.md" with { type: "text" };
import { architectureEntries, handoffArchitecture, handoffSection } from "./architecture.ts";

/**
 * The handoff bundle (#49): a folder that any coding agent can read.
 *
 * - `HANDOFF.md`: the instructions. It comes from a template, and the user edits it before the run.
 * - `design/`: the design's files, with the design system files they link (`exportFolder()`).
 * - `screenshots/`: one PNG of the whole page for each page and frame.
 * - `tokens.css`: the CSS custom properties of the design system, or else of the design.
 * - `architecture/`: the project's UML diagrams as JSON and SVG, when the user enabled UML.
 */
export const HANDOFF_TEMPLATE = { version: "v1", text: template } as const;
export const HANDOFF_FILE = "HANDOFF.md";
export const MAX_HANDOFF = 100_000;
/** One browser renders all screenshots; this keeps a bundle to a few minutes at most. */
export const MAX_SCREENSHOTS = 24;
const MAX_REQUESTS = 20;
const MAX_REQUEST_CHARS = 500;

export interface Screenshot {
  page: string;
  frame: Frame;
  /** Path in the bundle. */
  path: string;
}

export interface Bundle {
  files: ZipEntry[];
  missing: string[];
  warnings: string[];
}

/**
 * The screenshots of the bundle, by page and then by frame: `screenshots/<page>-<frame>.png`.
 * Two pages with the same safe name ("a b.html", "a-b.html") get "-2", "-3" and so on.
 */
export function screenshotPlan(pages: string[], frames: Frame[]): Screenshot[] {
  const stems = new Set<string>();
  return pages.flatMap((page) => {
    const base = page.replace(/\.html?$/i, "").replace(/[^A-Za-z0-9-]+/g, "-");
    let stem = base;
    for (let n = 2; stems.has(stem); n++) stem = `${base}-${n}`;
    stems.add(stem);
    return frames.map((frame) => ({ page, frame, path: `screenshots/${stem}-${frame.id}.png` }));
  });
}

/** The HTML pages of a design, index.html first. */
async function pagesOf(workspace: string, project: string, design: string): Promise<string[]> {
  if (!(await Bun.file(join(designDir(workspace, project, design), "index.html")).exists())) throw new ExportError("Design not found.");
  return designPages(workspace, project, design);
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
/** Markdown inline code that a backtick in the value cannot end. */
const code = (value: string) => `\`${value.replace(/`/g, "'")}\``;

/** At-rules whose custom properties apply only in some cases (a dark scheme, a width). */
const CONDITIONAL = /^@(media|supports|container|scope|starting-style|document)\b/i;
const ROOT_SELECTOR = /^(:root|html)$/i;

/**
 * The same text with comments, strings and url() values blanked out (same length), so braces
 * and semicolons in them do not count. Values are read from the original text at the same places.
 */
function maskCss(css: string): string {
  const blank = (m: string) => " ".repeat(m.length);
  return css
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => m[0] + " ".repeat(m.length - 2) + m[0])
    .replace(/url\(\s*[^)"'\s][^)]*\)/gi, (m) => "url(" + " ".repeat(m.length - 5) + ")");
}

/** Which of two declarations wins: by importance, then by layer, then by order. */
interface Rank {
  important: boolean;
  /** The layer path as the order of each layer among its siblings; [] is unlayered. */
  layers: number[];
  /** 10 for `:root` (a pseudo-class), 1 for `html` (a type selector). */
  specificity: number;
  order: number;
}

/** True when `a` beats `b` in the cascade (CSS Cascade 5: importance, layers, specificity, order). */
function beats(a: Rank, b: Rank): boolean {
  if (a.important !== b.important) return a.important;
  for (let i = 0; ; i++) {
    const x = a.layers[i];
    const y = b.layers[i];
    if (x === undefined && y === undefined) break;
    if (x === y) continue;
    // Normal: the declaration outside a layer, or in the later layer, wins. Important: the reverse.
    const aWins = x === undefined ? true : y === undefined ? false : x > y;
    return a.important ? !aWins : aWins;
  }
  if (a.specificity !== b.specificity) return a.specificity > b.specificity;
  return a.order > b.order;
}

/**
 * The custom properties on `:root` or `html` in the CSS, as the cascade gives them: an
 * important declaration beats a normal one, a declaration outside a layer beats one in a
 * layer (the reverse for important ones), a later layer beats an earlier one, `:root` beats
 * `html`, and then a later declaration wins. Declarations in conditional at-rules (`@media`, `@supports`, …) do not
 * count. `:root` beats `html` (specificity). Only these two selectors count, so other forms
 * (`:root:root`, `html:root`) are not read.
 */
export function rootTokens(css: string): Map<string, string> {
  const masked = maskCss(css);
  const won = new Map<string, { value: string; rank: Rank }>();
  /** The order of each layer path among its siblings, by first sight. */
  const layerOrder = new Map<string, number>();
  const stack: { prelude: string; layer: string[] }[] = [];
  let order = 0;

  const layerIndex = (path: string[]): number[] =>
    path.map((_, i) => {
      const key = path.slice(0, i + 1).join(".");
      if (!layerOrder.has(key)) layerOrder.set(key, layerOrder.size);
      return layerOrder.get(key)!;
    });
  /** Notes the layers of `@layer a, b;` statements in a segment, in order. */
  const layerStatements = (from: number, to: number) => {
    const parent = stack.at(-1)?.layer ?? [];
    for (const m of masked.slice(from, to).matchAll(/@layer\s+([^;{]+);/gi)) {
      for (const name of m[1]!.split(",")) layerIndex([...parent, ...name.trim().split(".")]);
    }
  };
  const apply = (from: number, to: number) => {
    const top = stack.at(-1);
    if (!top || stack.some((b) => CONDITIONAL.test(b.prelude))) return;
    const parts = top.prelude.split(",").map((part) => part.trim());
    if (!parts.some((part) => ROOT_SELECTOR.test(part))) return;
    // In a list, the matching selector with the highest specificity counts.
    const specificity = parts.some((part) => /^:root$/i.test(part)) ? 10 : 1;
    const layers = layerIndex(top.layer);
    for (const m of masked.slice(from, to).matchAll(/(--[A-Za-z0-9_-]+)\s*:([^;]*)/g)) {
      const at = from + m.index! + m[0].length - m[2]!.length;
      let value = css.slice(at, at + m[2]!.length).trim();
      const important = /!\s*important\s*$/i.test(value);
      if (important) value = value.replace(/\s*!\s*important\s*$/i, "");
      const rank = { important, layers, specificity, order: order++ };
      const before = won.get(m[1]!);
      if (!before || beats(rank, before.rank)) {
        won.delete(m[1]!);
        won.set(m[1]!, { value, rank });
      }
    }
  };

  let start = 0;
  let anonymous = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "{") {
      // Before a nested rule: the declarations up to the last ";" belong to the outer rule.
      const cut = masked.lastIndexOf(";", i - 1);
      const split = cut >= start ? cut + 1 : start;
      layerStatements(start, split);
      apply(start, split);
      const prelude = masked.slice(split, i).trim();
      const parent = stack.at(-1)?.layer ?? [];
      const layer = /^@layer\b/i.test(prelude)
        ? [...parent, ...(prelude.slice(6).trim() || `#anonymous-${anonymous++}`).split(".")]
        : parent;
      stack.push({ prelude, layer });
      start = i + 1;
    } else if (masked[i] === "}") {
      layerStatements(start, i);
      apply(start, i);
      stack.pop();
      start = i + 1;
    }
  }
  layerStatements(start, masked.length);
  return new Map([...won].map(([name, v]) => [name, v.value]));
}

/**
 * tokens.css of the bundle: the custom properties of `:root` as index.html gets them, with its
 * stylesheets in order (the design system files first, then the design's own). When the page
 * sets none, the tokens of the project's design system. Null when there are none.
 */
export async function bundleTokens(workspace: string, project: string, design: string): Promise<{ css: string; from: string } | null> {
  const page = await exportPage(workspace, project, design, { stripOids: false });
  const styles = [...page.html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!);
  let tokens = [...rootTokens(styles.join("\n"))];
  let from = "the stylesheets of index.html";
  const ds = tokens.length ? null : await activeDesignSystem(workspace, project);
  if (ds?.tokens) {
    tokens = [...rootTokens(ds.tokens)];
    from = `the design system "${ds.name}"`;
  }
  if (!tokens.length) return null;
  const lines = tokens.map(([name, value]) => `  ${name}: ${value};`);
  return { css: `/* The tokens of ${from}, from doi. */\n:root {\n${lines.join("\n")}\n}\n`, from };
}

/** HANDOFF.md as the template makes it: the user edits it before the run. */
export async function draftHandoff(workspace: string, project: string, design: string): Promise<string> {
  const pages = await pagesOf(workspace, project, design);
  const [frames, chat, comments, tokens, projects, oids, architecture] = await Promise.all([
    readLayout(workspace, project, design),
    readChat(workspace, project, design),
    readComments(workspace, project, design),
    bundleTokens(workspace, project, design),
    listProjects(workspace),
    readDesignFiles(designDir(workspace, project, design)).then(designOids),
    handoffArchitecture(workspace, project),
  ]);

  const asked = chat.flatMap((e) => (e.role === "user" ? [e] : []));
  const requests = asked.slice(-MAX_REQUESTS).map((e) => {
    const target = e.target ? `(element ${code(e.target)}) ` : "";
    return `- ${target}${oneLine(e.text, MAX_REQUEST_CHARS)}`;
  });
  if (asked.length > MAX_REQUESTS) requests.unshift(`- (${asked.length - MAX_REQUESTS} older requests are not in this list.)`);

  const open = comments.filter((c) => c.status === "open");
  const values: Record<string, string> = {
    // One line each: a line break in a name must not start a new Markdown block.
    project: oneLine(projects.find((p) => p.id === project)?.name ?? project, 200),
    design,
    requests: requests.length ? requests.join("\n") : "- None. The chat has no requests for this design.",
    pages: pages.map((p) => `  - ${code(`design/${p}`)}`).join("\n"),
    screenshots: screenshotPlan(pages, frames)
      .slice(0, MAX_SCREENSHOTS)
      .map((s) => `  - ${code(s.path)}: ${code(s.page)} in the frame ${oneLine(s.frame.label, 100)}, ${s.frame.width} × ${s.frame.height}`)
      .join("\n"),
    tokens: tokens
      ? `${code("tokens.css")}: the tokens (CSS custom properties) of ${tokens.from}.`
      : `There is no ${code("tokens.css")}: the design has no CSS custom properties.`,
    comments: open.length
      ? open
          .map((c) => {
            const gone = oids.has(c.oid) ? "" : " (This element is not in the design now.)";
            return `- On ${code(c.oid)}: ${oneLine(c.text, 2000)}${gone}`;
          })
          .join("\n")
      : "None.",
    architecture: handoffSection(architecture),
  };
  // One pass: a value that has {{name}} in it stays as it is.
  return HANDOFF_TEMPLATE.text.replace(/\{\{(\w+)\}\}/g, (all, key: string) => values[key] ?? all);
}

/** Checks the HANDOFF.md text that the user sends. */
export function checkHandoff(markdown: unknown): string {
  if (typeof markdown !== "string" || !markdown.trim()) throw new ExportError("markdown must be a non-empty string.", 400);
  if (markdown.length > MAX_HANDOFF) throw new ExportError(`markdown must be at most ${MAX_HANDOFF} characters.`, 400);
  return markdown;
}

const utf8 = new TextEncoder();

/** Builds the bundle with the user's HANDOFF.md. `render` makes the PNGs; tests pass their own. */
export async function buildBundle(
  workspace: string,
  project: string,
  design: string,
  markdown: unknown,
  render: typeof renderPngs = renderPngs,
): Promise<Bundle> {
  const handoff = checkHandoff(markdown);
  const pages = await pagesOf(workspace, project, design);
  // The data-oid attributes stay: HANDOFF.md names the elements of the comments by them.
  const folder = await exportFolder(workspace, project, design, { stripOids: false });
  const missing = new Set(folder.missing);
  const warnings = new Set(folder.warnings);

  const plan = screenshotPlan(pages, await readLayout(workspace, project, design));
  if (plan.length > MAX_SCREENSHOTS) {
    warnings.add(`The bundle has the first ${MAX_SCREENSHOTS} of ${plan.length} screenshots.`);
  }
  const shots: ZipEntry[] = [];
  const chosen = plan.slice(0, MAX_SCREENSHOTS);
  for (const page of pages) {
    const forPage = chosen.filter((s) => s.page === page);
    if (!forPage.length) continue;
    const result = await exportPage(workspace, project, design, { stripOids: false, page });
    for (const m of result.missing) missing.add(m);
    const pngs = await render(
      result.html,
      forPage.map((s) => s.frame),
      { scale: 1, fullPage: true },
    );
    forPage.forEach((s, i) => shots.push({ path: s.path, data: new Uint8Array(pngs[i]!) }));
  }

  const tokens = await bundleTokens(workspace, project, design);
  const diagrams = await architectureEntries(await handoffArchitecture(workspace, project));
  return {
    files: [
      { path: HANDOFF_FILE, data: utf8.encode(handoff) },
      ...folder.files.map((f) => ({ path: `design/${f.path}`, data: f.data })),
      ...shots,
      ...(tokens ? [{ path: "tokens.css", data: utf8.encode(tokens.css) }] : []),
      ...diagrams,
    ],
    missing: [...missing].sort(),
    warnings: [...warnings],
  };
}

/** Writes the bundle into `dir` (for a handoff run). A file with the same path is replaced. */
export async function writeBundle(bundle: Bundle, dir: string): Promise<void> {
  for (const f of bundle.files) {
    const path = join(dir, f.path);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, f.data);
  }
}
