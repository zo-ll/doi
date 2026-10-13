import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readDesignFiles } from "../generation/context.ts";
import { designOids } from "../generation/oids.ts";
import { ExportError, exportFolder, exportPage } from "../export/html.ts";
import { renderPngs } from "../export/render.ts";
import type { ZipEntry } from "../export/zip.ts";
import { readChat } from "../workspace/chat.ts";
import { readComments } from "../workspace/comments.ts";
import { activeDesignSystem, parseTokens } from "../workspace/design-systems.ts";
import { readLayout } from "../workspace/layout.ts";
import type { Frame } from "../workspace/frames.ts";
import { designDir, listProjects } from "../workspace/paths.ts";
import template from "./template-v0.md" with { type: "text" };

/**
 * The handoff bundle (#49): a folder that any coding agent can read.
 *
 * - `HANDOFF.md`: the instructions. It comes from a template, and the user edits it before the run.
 * - `design/`: the design's files, with the design system files they link (`exportFolder()`).
 * - `screenshots/`: one PNG of the whole page for each page and frame.
 * - `tokens.css`: the CSS custom properties of the design system, or else of the design.
 */
export const HANDOFF_TEMPLATE = { version: "v0", text: template } as const;
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

/** The screenshots of the bundle, by page and then by frame: `screenshots/<page>-<frame>.png`. */
export function screenshotPlan(pages: string[], frames: Frame[]): Screenshot[] {
  return pages.flatMap((page) => {
    const stem = page.replace(/\.html?$/i, "").replace(/[^A-Za-z0-9-]+/g, "-");
    return frames.map((frame) => ({ page, frame, path: `screenshots/${stem}-${frame.id}.png` }));
  });
}

/** The HTML pages of a design, index.html first. */
async function designPages(workspace: string, project: string, design: string): Promise<string[]> {
  const dir = designDir(workspace, project, design);
  if (!(await Bun.file(join(dir, "index.html")).exists())) throw new ExportError("Design not found.");
  return (await readDesignFiles(dir)).map((f) => f.path).filter((p) => /\.html?$/i.test(p));
}

/**
 * tokens.css of the bundle: the custom properties of the project's design system, or else the
 * ones in the stylesheets of the design and of the design system files it links. Null when
 * there are none.
 */
export async function bundleTokens(workspace: string, project: string, design: string): Promise<{ css: string; from: string } | null> {
  const ds = await activeDesignSystem(workspace, project);
  let from = `the design system "${ds?.name}"`;
  let tokens = ds?.tokens ? parseTokens(ds.tokens) : [];
  if (!tokens.length) {
    from = "the stylesheets of the design";
    const { files } = await exportFolder(workspace, project, design, { stripOids: false });
    const css = files.flatMap((f) => (/\.css$/i.test(f.path) ? [new TextDecoder().decode(f.data)] : []));
    tokens = parseTokens(css.join("\n"));
  }
  if (!tokens.length) return null;
  const lines = tokens.map((t) => `  ${t.name}: ${t.value};`);
  return { css: `/* The tokens of ${from}, from doi. */\n:root {\n${lines.join("\n")}\n}\n`, from };
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
/** Markdown inline code that a backtick in the value cannot end. */
const code = (value: string) => `\`${value.replace(/`/g, "'")}\``;

/** HANDOFF.md as the template makes it: the user edits it before the run. */
export async function draftHandoff(workspace: string, project: string, design: string): Promise<string> {
  const pages = await designPages(workspace, project, design);
  const [frames, chat, comments, tokens, projects, oids] = await Promise.all([
    readLayout(workspace, project, design),
    readChat(workspace, project, design),
    readComments(workspace, project, design),
    bundleTokens(workspace, project, design),
    listProjects(workspace),
    readDesignFiles(designDir(workspace, project, design)).then(designOids),
  ]);

  const asked = chat.flatMap((e) => (e.role === "user" ? [e] : []));
  const requests = asked.slice(-MAX_REQUESTS).map((e) => {
    const target = e.target ? `(element ${code(e.target)}) ` : "";
    return `- ${target}${oneLine(e.text, MAX_REQUEST_CHARS)}`;
  });
  if (asked.length > MAX_REQUESTS) requests.unshift(`- (${asked.length - MAX_REQUESTS} older requests are not in this list.)`);

  const open = comments.filter((c) => c.status === "open");
  const values: Record<string, string> = {
    project: projects.find((p) => p.id === project)?.name ?? project,
    design,
    requests: requests.length ? requests.join("\n") : "- None. The chat has no requests for this design.",
    pages: pages.map((p) => `  - ${code(`design/${p}`)}`).join("\n"),
    screenshots: screenshotPlan(pages, frames)
      .slice(0, MAX_SCREENSHOTS)
      .map((s) => `  - ${code(s.path)}: ${code(s.page)} in the frame ${s.frame.label}, ${s.frame.width} × ${s.frame.height}`)
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
  const pages = await designPages(workspace, project, design);
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
  return {
    files: [
      { path: HANDOFF_FILE, data: utf8.encode(handoff) },
      ...folder.files.map((f) => ({ path: `design/${f.path}`, data: f.data })),
      ...shots,
      ...(tokens ? [{ path: "tokens.css", data: utf8.encode(tokens.css) }] : []),
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
