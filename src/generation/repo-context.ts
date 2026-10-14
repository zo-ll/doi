import { $ } from "bun";
import { extname, join } from "node:path";
import { cloneDir } from "../github/gh.ts";
import { projectRepo, type LinkedRepo } from "../workspace/paths.ts";
import { repoFiles } from "./repo-scan.ts";

/**
 * The linked repo as context for a turn (#112): the designs are for this app. A model that
 * works in files (Claude Code) reads the code itself from the cache clone; other models get
 * the file tree and a bounded set of the main files.
 */
export const REPO_LIMITS = { tree: 1500, perFile: 12_000, total: 60_000 } as const;

const CODE_EXT = new Set([".tsx", ".jsx", ".ts", ".js", ".vue", ".svelte", ".astro", ".html", ".css", ".scss", ".md", ".json", ".mdx", ".erb", ".php", ".py", ".rb", ".go", ".swift", ".kt", ".dart"]);
/** Folders that hold screens and their parts, in most web and app frameworks. */
const UI_DIR = /(^|\/)(pages|app|routes|views|screens|layouts|components|ui|templates)\//i;
const FIRST = /(^|\/)(readme\.md|package\.json|tailwind\.config\.[a-z]+|theme\.[a-z]+|globals?\.css|app\.css|index\.css)$/i;

/** Makes the cache clone match its commit again: a model may have written into it. */
export async function restoreClone(dir: string): Promise<void> {
  await $`git checkout -- . && git clean -fdq`.cwd(dir).quiet().nothrow();
}

/** The files for a model that cannot read the clone: the start files, then the UI files, by depth. */
export async function pickFiles(dir: string, paths: string[]): Promise<{ path: string; content: string }[]> {
  const rank = (p: string) => (FIRST.test(p) ? 0 : UI_DIR.test(p) ? 1 : 2);
  const candidates = paths
    .filter((p) => CODE_EXT.has(extname(p).toLowerCase()) && !/(\.test|\.spec|\.stories|\.min|\.lock|-lock)\./i.test(p) && rank(p) < 2)
    .sort((a, b) => rank(a) - rank(b) || a.split("/").length - b.split("/").length || a.localeCompare(b));
  const out: { path: string; content: string }[] = [];
  let total = 0;
  for (const path of candidates) {
    if (total >= REPO_LIMITS.total) break;
    let text = await Bun.file(join(dir, path)).text();
    if (text.length > REPO_LIMITS.perFile) text = `${text.slice(0, REPO_LIMITS.perFile)}\n… (cut)`;
    if (total + text.length > REPO_LIMITS.total) continue;
    total += text.length;
    out.push({ path, content: text });
  }
  return out;
}

/** The system part for the linked repo. `readsFiles`: the model can open files in `dir` itself. */
export async function formatRepo(repo: LinkedRepo, dir: string, readsFiles: boolean): Promise<string> {
  const paths = await repoFiles(dir);
  const tree = paths.slice(0, REPO_LIMITS.tree).join("\n") + (paths.length > REPO_LIMITS.tree ? `\n… and ${paths.length - REPO_LIMITS.tree} more files` : "");
  const lines = [
    `# The app: ${repo.name}`,
    "",
    `This project designs the app in the GitHub repo ${repo.name} (commit ${repo.commit.slice(0, 7)}). ${readsFiles ? `A read-only copy of its code is at ${dir}.` : "Its main files are below."}`,
    "",
    "- When the user asks to recreate a screen, a page or a component of the app, read its code first. Then build it in the design files as plain HTML and CSS, with the app's real text, structure, states and styles.",
    "- Use the app's own colors, fonts, spacing and components from its styles and theme files, unless a design system above says otherwise.",
    "- The repo copy is read only. Do not change, add or delete files in it. Write only the design files.",
    "- Do not copy secrets, keys or personal data from the code into a design.",
    "",
    "## Files",
    "",
    "```",
    tree,
    "```",
  ];
  if (!readsFiles) {
    for (const f of await pickFiles(dir, paths)) lines.push("", `## ${f.path}`, "", "```", f.content, "```");
  }
  return lines.join("\n");
}

/** The linked repo of a project for one turn: its text part and the clone folder; null without a usable clone. */
export async function repoForTurn(workspace: string, project: string, readsFiles: boolean): Promise<{ text: string; dir: string } | null> {
  const repo = await projectRepo(workspace, project);
  if (!repo) return null;
  const dir = cloneDir(workspace, repo.name);
  if (!(await Bun.file(join(dir, ".git", "HEAD")).exists())) return null; // gone from the cache: link it again
  await restoreClone(dir);
  return { text: await formatRepo(repo, dir, readsFiles), dir };
}
