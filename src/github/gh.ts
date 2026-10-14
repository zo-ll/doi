import { mkdir, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { REPO_NAME } from "../workspace/paths.ts";

/**
 * GitHub through the official `gh` CLI (#112). doi only runs `gh` commands; the CLI uses its
 * own login. doi never reads, copies or stores the gh token, and it shows no account detail
 * except the repo names that the user picks from.
 */

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GhDeps {
  which: (bin: string) => string | null;
  /** Runs a command; `cwd` is the folder for git commands. */
  run: (cmd: string[], options?: { cwd?: string; timeout?: number }) => Promise<GhResult>;
}

const TIMEOUT = 15_000;
/** A clone of a big repo takes a while; it stays shallow. */
const CLONE_TIMEOUT = 5 * 60_000;

export const ghDeps: GhDeps = {
  which: (bin) => Bun.which(bin),
  async run(cmd, options = {}) {
    const proc = Bun.spawn(cmd, {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: options.timeout ?? TIMEOUT,
      // No prompt for a password or a host key: a command that needs one fails instead.
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  },
};

export class GhError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

export { REPO_NAME };

export interface GhStatus {
  installed: boolean;
  loggedIn: boolean;
}

/** Only the exit code of `gh auth status`: its output names the account and the token scopes. */
export async function ghStatus(deps: GhDeps = ghDeps): Promise<GhStatus> {
  if (!deps.which("gh")) return { installed: false, loggedIn: false };
  const r = await deps.run(["gh", "auth", "status"]);
  return { installed: true, loggedIn: r.code === 0 };
}

export interface RepoSummary {
  name: string;
  description: string;
  private: boolean;
  language: string | null;
  updatedAt: string;
}

const FIELDS = "nameWithOwner,description,isPrivate,primaryLanguage,updatedAt";

function toSummary(r: Record<string, unknown>): RepoSummary | null {
  const name = r.nameWithOwner;
  if (typeof name !== "string" || !REPO_NAME.test(name)) return null;
  const lang = r.primaryLanguage as { name?: unknown } | null;
  return {
    name,
    description: typeof r.description === "string" ? r.description : "",
    private: r.isPrivate === true,
    language: typeof lang?.name === "string" ? lang.name : null,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
  };
}

const failed = (what: string, r: GhResult) => new GhError(`${what} failed: ${r.stderr.trim().split("\n").at(-1) || `gh exit ${r.code}`}`);

/** The repos of the logged-in account, newest first. */
export async function listRepos(deps: GhDeps = ghDeps, limit = 100): Promise<RepoSummary[]> {
  const r = await deps.run(["gh", "repo", "list", "--limit", String(limit), "--json", FIELDS]);
  if (r.code !== 0) throw failed("gh repo list", r);
  const list = JSON.parse(r.stdout) as Record<string, unknown>[];
  return list
    .map(toSummary)
    .filter((x): x is RepoSummary => x !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** One repo by name, for a repo of another owner or an organization. Throws when gh cannot see it. */
export async function viewRepo(name: string, deps: GhDeps = ghDeps): Promise<RepoSummary> {
  if (!REPO_NAME.test(name)) throw new GhError(`"${name}" is not a repo name. Use owner/repo.`, 400);
  const r = await deps.run(["gh", "repo", "view", name, "--json", FIELDS]);
  if (r.code !== 0) throw new GhError(`gh cannot see ${name}. Check the name, or that your gh account has access to it.`, 404);
  const s = toSummary(JSON.parse(r.stdout));
  if (!s) throw new GhError(`gh gave no valid repo for ${name}.`);
  return s;
}

/** The folder of a repo's clone in the workspace cache. */
export function cloneDir(workspace: string, name: string): string {
  if (!REPO_NAME.test(name)) throw new GhError(`"${name}" is not a repo name.`, 400);
  const [owner, repo] = name.split("/") as [string, string];
  const root = join(workspace, ".repos");
  const dir = join(root, owner.toLowerCase(), repo.toLowerCase());
  // Two levels under .repos, never .repos itself or above it.
  if (relative(root, dir).split(sep).length !== 2 || relative(root, dir).startsWith("..")) throw new GhError(`"${name}" is not a repo name.`, 400);
  return dir;
}

/**
 * Makes the clone match the default branch of the repo: a new shallow clone, or a fetch of the
 * latest commit and a hard reset of the cache copy (it is doi's own copy, never the user's
 * checkout). Returns the commit.
 */
export async function syncClone(workspace: string, name: string, deps: GhDeps = ghDeps): Promise<string> {
  const dir = cloneDir(workspace, name);
  const exists = await Bun.file(join(dir, ".git", "HEAD")).exists();
  if (exists) {
    const fetch = await deps.run(["git", "fetch", "--depth", "1", "origin", "HEAD"], { cwd: dir, timeout: CLONE_TIMEOUT });
    if (fetch.code !== 0) throw failed("git fetch", fetch);
    for (const cmd of [["git", "reset", "--hard", "FETCH_HEAD"], ["git", "clean", "-fdxq"]]) {
      const r = await deps.run(cmd, { cwd: dir });
      if (r.code !== 0) throw failed(cmd.slice(0, 2).join(" "), r);
    }
  } else {
    await mkdir(dirname(dir), { recursive: true });
    await rm(dir, { recursive: true, force: true }); // a clone that a crash cut
    const r = await deps.run(["gh", "repo", "clone", name, dir, "--", "--depth", "1", "--single-branch", "--quiet"], { timeout: CLONE_TIMEOUT });
    if (r.code !== 0) {
      await rm(dir, { recursive: true, force: true });
      throw failed("gh repo clone", r);
    }
  }
  const head = await deps.run(["git", "rev-parse", "HEAD"], { cwd: dir });
  if (head.code !== 0) throw failed("git rev-parse", head);
  return head.stdout.trim();
}

/** Keeps the clones out of the workspace's own git: a line in its local exclude file. */
export async function excludeClones(workspace: string): Promise<void> {
  const file = join(workspace, ".git", "info", "exclude");
  if (!(await Bun.file(join(workspace, ".git", "HEAD")).exists())) return;
  const text = (await Bun.file(file).exists()) ? await Bun.file(file).text() : "";
  if (text.split("\n").some((l) => l.trim() === "/.repos/")) return;
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}/.repos/\n`);
}
