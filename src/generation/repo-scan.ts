import { $ } from "bun";
import { lstat, readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

/** A file of a repo that tells the model about its design. */
export interface Source {
  /** Path in the repo, with "/" separators. */
  path: string;
  kind: "config" | "styles" | "component";
  content: string;
  /** The content was cut to the per-file limit. */
  cut: boolean;
}

export const SCAN_LIMITS = { files: 20_000, perFile: 12_000, total: 100_000, components: 12, styles: 8 } as const;

/** Folders that hold built, vendored or tool files, never the design source. */
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage", "vendor", "target", "venv", "__pycache__",
  "storybook-static",
]);
/** Files that can hold secrets are never read, whatever their name says. */
const SECRET = /(^|\/)(\.env[^/]*|.*\.(pem|key|p12|pfx|crt)|id_[a-z0-9]+|credentials[^/]*|secrets?[^/]*)$/i;

const CONFIG = /(^|\/)(tailwind\.config|theme|tokens|design-tokens|colors|typography)\.(js|cjs|mjs|ts|json)$|\.tokens\.json$/i;
const STYLE_EXT = new Set([".css", ".scss", ".sass", ".less", ".pcss"]);
const COMPONENT = /(^|\/)(button|btn|card|input|text-?field|text-?input|nav|navbar|nav-?bar|header|menu|badge|modal|dialog|select|checkbox|tabs?|link)\.(tsx|jsx|vue|svelte|astro|html)$/i;

/** Custom properties and preprocessor variables: the tokens a stylesheet defines. */
const countTokens = (css: string) => (css.match(/(^|[\s;{])(--[a-z][\w-]*|\$[a-z][\w-]*|@[a-z][\w-]*)\s*:/gim) ?? []).length;

/** True when a path has a skipped folder or a dot part in it. */
const skipped = (path: string) =>
  path.split("/").some((part, i, all) => part.startsWith(".") || (i < all.length - 1 && SKIP_DIRS.has(part.toLowerCase())));

/**
 * In a git repo, the files git sees: tracked and new ones, without ignored ones (a local build
 * or a dev workspace). `git ls-files` only reads. Null when the folder is not a git repo.
 */
async function gitFiles(root: string): Promise<string[] | null> {
  if (!(await Bun.file(join(root, ".git", "HEAD")).exists())) return null;
  const r = await $`git ls-files -z --cached --others --exclude-standard`.cwd(root).quiet().nothrow();
  if (r.exitCode !== 0) return null;
  const out: string[] = [];
  for (const path of r.stdout.toString().split("\0")) {
    if (!path || skipped(path)) continue;
    // Links can point anywhere; only plain files are read.
    try {
      if ((await lstat(join(root, path))).isFile()) out.push(path);
    } catch {
      // Deleted but still in the index.
    }
    if (out.length >= SCAN_LIMITS.files) break;
  }
  return out;
}

/** The repo-relative paths of its files, without skipped folders, dot files and links. */
async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [root];
  while (queue.length && out.length < SCAN_LIMITS.files) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) queue.push(full);
      } else if (e.isFile()) {
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  }
  return out;
}

/**
 * The files of a repo that doi may read: git's files (or a walk), without built, vendored and
 * dot folders, links, and files that can hold secrets.
 */
export async function repoFiles(root: string): Promise<string[]> {
  return ((await gitFiles(root)) ?? (await walk(root))).filter((p) => !SECRET.test(p));
}

/** Picks the configs, the stylesheets with the most tokens and the main components. */
export async function scanRepo(root: string): Promise<{ sources: Source[]; seen: number }> {
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error("The repo path is not a folder.");
  const paths = await repoFiles(root);

  const read = async (path: string) => Bun.file(join(root, path)).text();
  const configs = paths.filter((p) => CONFIG.test(p));
  const styles: { path: string; content: string; tokens: number }[] = [];
  for (const p of paths.filter((p) => STYLE_EXT.has(extname(p).toLowerCase()) && !/\.min\./.test(p))) {
    const content = await read(p);
    const tokens = countTokens(content);
    if (tokens > 0) styles.push({ path: p, content, tokens });
  }
  styles.sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path));
  // Shorter paths first: src/components/Button.tsx before a deep example copy.
  const components = paths
    .filter((p) => COMPONENT.test(p) && !/(\.test|\.spec|\.stories)\./i.test(p))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, SCAN_LIMITS.components);

  const picked: { path: string; kind: Source["kind"]; content?: string }[] = [
    ...configs.map((path) => ({ path, kind: "config" as const })),
    ...styles.slice(0, SCAN_LIMITS.styles).map(({ path, content }) => ({ path, kind: "styles" as const, content })),
    ...components.map((path) => ({ path, kind: "component" as const })),
  ];
  const sources: Source[] = [];
  let total = 0;
  for (const p of picked) {
    if (total >= SCAN_LIMITS.total) break;
    const text = p.content ?? (await read(p.path));
    const room = Math.min(SCAN_LIMITS.perFile, SCAN_LIMITS.total - total);
    const cut = text.length > room;
    const content = cut ? text.slice(0, room) : text;
    total += content.length;
    sources.push({ path: p.path, kind: p.kind, content, cut });
  }
  return { sources, seen: paths.length };
}

/** The sources as one user message. */
export function formatSources(repoName: string, sources: Source[]): string {
  const lang = (p: string) => extname(p).slice(1) || "text";
  const blocks = sources.map(
    (s) => `## ${s.path} (${s.kind})${s.cut ? " — cut to the first part" : ""}\n\`\`\`${lang(s.path)}\n${s.content.trimEnd()}\n\`\`\``,
  );
  return [`Make a design system from the repo "${repoName}". These are its design files:`, ...blocks].join("\n\n");
}
