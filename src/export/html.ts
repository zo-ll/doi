import { readdir } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { designSystemDir, loadDesignSystem } from "../workspace/design-systems.ts";
import { designDir, fileIn } from "../workspace/paths.ts";
import type { ZipEntry } from "./zip.ts";

/**
 * HTML export of a design (#46): a folder with the design's files and the design system files
 * that its pages link, or one self-contained HTML page. Pages link the design system at
 * /ds/<name>/…; the export puts these files in `design-system/<name>/` and links them by a
 * relative path, or inlines them. The bridge script is never in the files on disk.
 */
export interface ExportOptions {
  /** Removes every data-oid attribute from the HTML. */
  stripOids: boolean;
}

export interface FolderExport {
  files: ZipEntry[];
  /** Local files that a page or stylesheet names but that do not exist. */
  missing: string[];
  warnings: string[];
}

export interface PageExport {
  html: string;
  missing: string[];
  warnings: string[];
}

export class ExportError extends Error {
  constructor(
    message: string,
    readonly status = 404,
  ) {
    super(message);
  }
}

/** Folder of the design system files in an export. */
export const DS_FOLDER = "design-system";
const BASE = "http://export.invalid/";
const utf8 = new TextEncoder();

const hidden = (path: string) => path.split("/").some((part) => part.startsWith("."));
const isCss = (path: string) => /\.css$/i.test(path);
const isHtml = (path: string) => /\.html?$/i.test(path);

/** The files of a design and of the design systems it links, by export path. */
interface Source {
  designFiles: string[];
  read(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
}

async function openSource(workspace: string, project: string, design: string): Promise<Source> {
  const dir = designDir(workspace, project, design);
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    throw new ExportError(`Design "${project}/${design}" does not exist.`);
  }
  const designFiles = entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"))
    // Hidden files (comments) are app data, not part of the design.
    .filter((p) => !hidden(p))
    .sort();
  if (designFiles.some((p) => p.split("/")[0] === DS_FOLDER)) {
    throw new ExportError(`The design has its own "${DS_FOLDER}" folder. Rename it before an export.`, 409);
  }

  async function readFile(path: string | null): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!path) return null;
    const f = Bun.file(path);
    return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
  }

  return {
    designFiles,
    async read(path) {
      if (hidden(path)) return null;
      const [top, name, ...rest] = path.split("/");
      if (top !== DS_FOLDER) return readFile(fileIn(dir, path));
      if (!name || !rest.length) return null;
      let dsDir: string;
      try {
        dsDir = designSystemDir(workspace, name);
      } catch {
        return null;
      }
      const file = await readFile(fileIn(dsDir, rest.join("/")));
      if (file || rest.join("/") !== "components.css") return file;
      // Without components.css, the <style> blocks of components.html are the components' CSS.
      const ds = await loadDesignSystem(workspace, name);
      return ds?.componentStyles ? utf8.encode(ds.componentStyles) : null;
    },
  };
}

/**
 * The export path that `ref` names from the file `from`, or null for a link that is not a local
 * file (another site, data:, a fragment, or a server path other than /ds/).
 */
export function resolveRef(ref: string, from: string): { path: string; suffix: string; dsAbsolute: boolean } | null {
  const r = ref.trim();
  if (!r || r.startsWith("#") || r.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(r)) return null;
  let url: URL;
  let path: string;
  try {
    url = new URL(r, BASE + from);
    path = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
  const absolute = r.startsWith("/");
  if (absolute && path.startsWith("ds/")) path = `${DS_FOLDER}/${path.slice(3)}`;
  else if (absolute) return null;
  if (!path || path.endsWith("/")) return null;
  return { path, suffix: url.search + url.hash, dsAbsolute: absolute };
}

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/gi;

/** The links in a stylesheet: url(…) values and @import strings. */
function cssRefs(css: string): string[] {
  const refs = [...css.matchAll(CSS_URL)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
  for (const m of css.matchAll(CSS_IMPORT)) if (m[4] !== undefined || m[5] !== undefined) refs.push(m[4] ?? m[5]!);
  return refs;
}

/** Replaces each link in a stylesheet for which `map` gives a new value. */
function mapCss(css: string, map: (ref: string) => string | null): string {
  const links = /@import\s+(?:"([^"]*)"|'([^']*)')|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi;
  return css.replace(links, (all, a, b, c, d, e) => {
    const next = map(a ?? b ?? c ?? d ?? e ?? "");
    if (next === null) return all;
    return a !== undefined || b !== undefined ? `@import url(${JSON.stringify(next)})` : `url(${JSON.stringify(next)})`;
  });
}

type RefKind = "stylesheet" | "script" | "page" | "asset";

/** Elements and attributes that name a file. */
const REF_ATTRS: [string, string][] = [
  ["link", "href"],
  ["script", "src"],
  ["img", "src"],
  ["img", "srcset"],
  ["source", "src"],
  ["source", "srcset"],
  ["video", "src"],
  ["video", "poster"],
  ["audio", "src"],
  ["track", "src"],
  ["input", "src"],
  ["iframe", "src"],
  ["embed", "src"],
  ["object", "data"],
  ["a", "href"],
  ["use", "href"],
  ["image", "href"],
];

function refKind(tag: string, attr: string, el: HTMLRewriterTypes.Element): RefKind {
  if (tag === "link") return /(^|\s)stylesheet(\s|$)/i.test(el.getAttribute("rel") ?? "") ? "stylesheet" : "asset";
  if (tag === "script") return "script";
  if (tag === "a" || tag === "iframe") return "page";
  return "asset";
}

/** The URLs of a srcset value. */
const srcsetUrls = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean);

function mapSrcset(value: string, map: (ref: string) => string | null): string {
  return value
    .split(",")
    .map((part) => {
      const [url = "", ...descriptor] = part.trim().split(/\s+/);
      const next = url ? map(url) : null;
      return [next ?? url, ...descriptor].join(" ");
    })
    .join(", ");
}

interface HtmlRef {
  kind: RefKind;
  value: string;
}

/** First pass over a page: its file links, and the CSS of its <style> elements and style attributes. */
async function scanHtml(html: string): Promise<{ refs: HtmlRef[]; css: string[] }> {
  const refs: HtmlRef[] = [];
  const css: string[] = [];
  let block: string | null = null;
  let rewriter = new HTMLRewriter()
    .on("style", {
      text(chunk) {
        block = (block ?? "") + chunk.text;
        if (chunk.lastInTextNode) {
          css.push(block);
          block = null;
        }
      },
    })
    .on("[style]", { element: (el) => void css.push(el.getAttribute("style")!) });
  for (const [tag, attr] of REF_ATTRS) {
    rewriter = rewriter.on(`${tag}[${attr}]`, {
      element(el) {
        const value = el.getAttribute(attr)!;
        const kind = refKind(tag, attr, el);
        if (attr === "srcset") for (const url of srcsetUrls(value)) refs.push({ kind, value: url });
        else refs.push({ kind, value });
      },
    });
  }
  await rewriter.transform(new Response(html)).text();
  return { refs, css };
}

interface HtmlRewrite {
  /** New value of a file link, or null to keep it. */
  ref(kind: RefKind, value: string): string | null;
  /** New CSS of a <style> element or a style attribute. */
  css(css: string): string;
  /** HTML that takes the place of a <link rel="stylesheet">, or null to keep the element. */
  stylesheet?(href: string, media: string | null): string | null;
  /** Source of a <script src>, which then goes inside the element, or null to keep the link. */
  script?(src: string): string | null;
  stripOids: boolean;
}

/** Escapes a closing tag inside inline CSS or a script, so it cannot close the element. */
const escapeClose = (text: string, tag: string) => text.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1");

/** Second pass over a page: applies the new links, the inlined files and the oid option. */
async function rewriteHtml(html: string, rw: HtmlRewrite): Promise<string> {
  let block: string | null = null;
  let rewriter = new HTMLRewriter()
    .on("style", {
      text(chunk) {
        block = (block ?? "") + chunk.text;
        if (chunk.lastInTextNode) {
          chunk.replace(rw.css(block), { html: true });
          block = null;
        } else chunk.remove();
      },
    })
    .on("[style]", { element: (el) => void el.setAttribute("style", rw.css(el.getAttribute("style")!)) });
  for (const [tag, attr] of REF_ATTRS) {
    rewriter = rewriter.on(`${tag}[${attr}]`, {
      element(el) {
        const value = el.getAttribute(attr);
        if (value === null) return; // removed by an earlier handler
        const kind = refKind(tag, attr, el);
        if (kind === "stylesheet" && rw.stylesheet) {
          const replacement = rw.stylesheet(value, el.getAttribute("media"));
          if (replacement !== null) return void el.replace(replacement, { html: true });
        }
        if (kind === "script" && rw.script) {
          const source = rw.script(value);
          if (source !== null) {
            el.removeAttribute("src");
            el.setInnerContent(escapeClose(source, "script"), { html: true });
            return;
          }
        }
        const next = attr === "srcset" ? mapSrcset(value, (url) => rw.ref(kind, url)) : rw.ref(kind, value);
        if (next !== null && next !== value) el.setAttribute(attr, next);
      },
    });
  }
  if (rw.stripOids) rewriter = rewriter.on("[data-oid]", { element: (el) => void el.removeAttribute("data-oid") });
  return rewriter.transform(new Response(html)).text();
}

/** A warning when the design's CSS or scripts use data-oid, which the strip option removes. */
function oidWarning(texts: string[]): string[] {
  return texts.some((t) => t.includes("data-oid"))
    ? ["The CSS or a script uses data-oid attributes. Without them, these rules or scripts do not match."]
    : [];
}

/**
 * Exports a design as a folder: its own files as they are, and the design system files that
 * they link (with the fonts that tokens.css loads) in `design-system/<name>/`. Links to
 * /ds/<name>/… become relative paths.
 */
export async function exportFolder(workspace: string, project: string, design: string, options: ExportOptions): Promise<FolderExport> {
  const source = await openSource(workspace, project, design);
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const missing = new Set<string>();
  const texts: string[] = [];
  const queue = [...source.designFiles];

  for (let i = 0; i < queue.length; i++) {
    const path = queue[i]!;
    if (files.has(path)) continue;
    const data = await source.read(path);
    if (!data) {
      missing.add(path);
      continue;
    }
    if (!isHtml(path) && !isCss(path)) {
      if (/\.m?js$/i.test(path)) texts.push(new TextDecoder().decode(data));
      files.set(path, data);
      continue;
    }

    const found = new Set<string>();
    /** Notes the file that a link names, and makes a /ds/ link relative to this file. */
    const map = (value: string): string | null => {
      const ref = resolveRef(value, path);
      if (!ref) return null;
      found.add(ref.path);
      if (!ref.dsAbsolute) return null;
      return posix.relative(posix.dirname(path), ref.path) + ref.suffix;
    };

    const text = new TextDecoder().decode(data);
    let out: string;
    if (isCss(path)) {
      texts.push(text);
      out = mapCss(text, map);
    } else {
      const scan = await scanHtml(text);
      texts.push(...scan.css);
      out = await rewriteHtml(text, { ref: (_kind, value) => map(value), css: (css) => mapCss(css, map), stripOids: options.stripOids });
    }
    files.set(path, utf8.encode(out));
    for (const p of found) if (!files.has(p) && !queue.includes(p)) queue.push(p);
  }

  return {
    files: [...files].map(([path, data]) => ({ path, data })),
    missing: [...missing].sort(),
    warnings: options.stripOids ? oidWarning(texts) : [],
  };
}

/** A data: URL for a file. */
function dataUrl(path: string, data: Uint8Array): string {
  const type = Bun.file(path).type.split(";")[0] || "application/octet-stream";
  return `data:${type};base64,${Buffer.from(data).toString("base64")}`;
}

/**
 * Exports one page of a design as a single HTML file: stylesheets (with their @imports) go
 * into <style> elements, scripts inline, and images, fonts and media become data: URLs.
 * Links to other sites (Google Fonts) stay links. Links to other pages do not work.
 */
export async function exportPage(
  workspace: string,
  project: string,
  design: string,
  options: ExportOptions & { page?: string },
): Promise<PageExport> {
  const source = await openSource(workspace, project, design);
  const page = options.page ?? "index.html";
  if (!isHtml(page) || !source.designFiles.includes(page)) throw new ExportError(`The design has no page "${page}".`);

  const missing = new Set<string>();
  const warnings = new Set<string>();
  const texts: string[] = [];
  const cache = new Map<string, Uint8Array<ArrayBuffer> | null>();
  const read = async (path: string) => {
    if (!cache.has(path)) cache.set(path, await source.read(path));
    const data = cache.get(path)!;
    if (!data) missing.add(path);
    return data;
  };

  /** CSS with its local @imports inlined and its url()s as data: URLs. */
  async function inlineCss(css: string, from: string, seen: string[]): Promise<string> {
    texts.push(css);
    let out = "";
    let last = 0;
    for (const m of css.matchAll(CSS_IMPORT)) {
      const ref = resolveRef(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "", from);
      if (!ref || seen.includes(ref.path)) continue;
      const data = await read(ref.path);
      if (!data) continue;
      const inner = await inlineCss(new TextDecoder().decode(data), ref.path, [...seen, ref.path]);
      const media = m[6]!.trim();
      out += css.slice(last, m.index) + (media ? `@media ${media} {\n${inner}\n}` : inner);
      last = m.index! + m[0].length;
    }
    out += css.slice(last);

    const urls = new Map<string, string>();
    for (const value of cssRefs(out)) {
      const ref = resolveRef(value, from);
      if (!ref || urls.has(value)) continue;
      const data = await read(ref.path);
      if (data) urls.set(value, dataUrl(ref.path, data) + ref.suffix.replace(/^\?[^#]*/, ""));
    }
    return mapCss(out, (value) => urls.get(value) ?? null);
  }

  const html = new TextDecoder().decode((await read(page))!);
  const scan = await scanHtml(html);

  const assets = new Map<string, string>();
  const sheets = new Map<string, string>();
  const scripts = new Map<string, string>();
  for (const { kind, value } of scan.refs) {
    const ref = resolveRef(value, page);
    if (!ref) continue;
    if (kind === "page") {
      if (ref.path !== page) warnings.add("Links to other pages of the design do not work in a single file.");
      continue;
    }
    const data = await read(ref.path);
    if (!data) continue;
    const text = () => new TextDecoder().decode(data);
    if (kind === "stylesheet") sheets.set(value, await inlineCss(text(), ref.path, [ref.path]));
    else if (kind === "script") {
      texts.push(text());
      scripts.set(value, text());
    } else assets.set(value, dataUrl(ref.path, data) + ref.suffix.replace(/^\?[^#]*/, ""));
  }
  const styles = new Map<string, string>();
  for (const css of scan.css) if (!styles.has(css)) styles.set(css, await inlineCss(css, page, [page]));

  const out = await rewriteHtml(html, {
    ref: (_kind, value) => assets.get(value) ?? null,
    css: (css) => escapeClose(styles.get(css) ?? css, "style"),
    stylesheet: (href, media) => {
      const css = sheets.get(href);
      if (css === undefined) return null;
      const attr = media ? ` media="${media.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"` : "";
      return `<style${attr}>\n${escapeClose(css, "style")}\n</style>`;
    },
    script: (src) => scripts.get(src) ?? null,
    stripOids: options.stripOids,
  });

  if (options.stripOids) for (const w of oidWarning(texts)) warnings.add(w);
  return { html: out, missing: [...missing].sort(), warnings: [...warnings] };
}
