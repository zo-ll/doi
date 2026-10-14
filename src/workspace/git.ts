import { $ } from "bun";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { chatFile } from "./chat.ts";
import { designDir, designFile } from "./paths.ts";
import { uploadsDir } from "./uploads.ts";

// One git command at a time: two turns on different designs must not race for the index lock.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

/** Runs git in the workspace. A failure throws with git's own message. */
async function git(workspace: string, args: string[]): Promise<string> {
  const result = await $`git ${args}`.cwd(workspace).quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim() || `exit code ${result.exitCode}`}`);
  }
  return result.stdout.toString();
}

/** Uncommitted changes in the workspace, for the status line; null when git is off. */
export async function workspaceChanges(workspace: string): Promise<number | null> {
  try {
    const out = await serial(() => git(workspace, ["status", "--porcelain"]));
    return out.split("\n").filter(Boolean).length;
  } catch {
    return null;
  }
}

/** Makes the workspace its own git repo on first run. A repo around it does not count. */
export async function ensureRepo(workspace: string): Promise<void> {
  if (await Bun.file(join(workspace, ".git", "HEAD")).exists()) return;
  await serial(() => git(workspace, ["init", "--quiet"]));
}

/** First line of the prompt, trimmed, at most 72 characters. */
export function commitMessage(prompt: string): string {
  const line = prompt.trim().split("\n")[0]!.trim() || "Design change";
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

/**
 * Commits only `paths`, so files the user staged elsewhere stay out of the commit. A path that
 * is gone counts when git tracks it (a rename or a delete). The commit uses the user's own git
 * identity. Returns the commit id, or null when nothing changed.
 */
export function commitPaths(workspace: string, paths: string[], message: string): Promise<string | null> {
  return serial(async () => {
    const present: string[] = [];
    for (const p of paths) {
      if (existsSync(p) || (await git(workspace, ["ls-files", "--", p])).trim()) present.push(p);
    }
    if (!present.length) return null;
    await git(workspace, ["add", "-A", "--", ...present]);
    if (!(await git(workspace, ["diff", "--cached", "--name-only", "--", ...present])).trim()) return null;
    await git(workspace, ["commit", "--quiet", "-m", commitMessage(message), "--", ...present]);
    return (await git(workspace, ["rev-parse", "HEAD"])).trim();
  });
}

/** Commits the design folder, the project's chat and its uploads after a completed turn. */
export function commitTurn(workspace: string, project: string, design: string, prompt: string): Promise<string | null> {
  return commitPaths(
    workspace,
    [designDir(workspace, project, design), chatFile(workspace, project), uploadsDir(workspace, project)],
    prompt,
  );
}

/** The last commit that changed the design folder, or null when there is none yet. */
export function designVersion(workspace: string, project: string, design: string): Promise<string | null> {
  return serial(async () => {
    try {
      return (await git(workspace, ["log", "-1", "--format=%H", "--", designDir(workspace, project, design)])).trim() || null;
    } catch {
      return null; // a repo without commits
    }
  });
}

/** One version of a design: a commit that changed its folder. */
export interface Version {
  sha: string;
  /** Commit time, ISO 8601. */
  at: string;
  /** The first line of the commit message: the prompt, or what the user did. */
  message: string;
}

const SHA = /^[0-9a-f]{7,40}$/;
export const isSha = (s: string) => SHA.test(s);

/** The versions of a design, newest first. A design that was renamed starts at the rename. */
export function designLog(workspace: string, project: string, design: string, limit = 200): Promise<Version[]> {
  return serial(async () => {
    let out: string;
    try {
      out = await git(workspace, ["log", `-${limit}`, "--format=%H%x1f%aI%x1f%s", "--", designDir(workspace, project, design)]);
    } catch {
      return []; // a repo without commits
    }
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, at, message] = line.split("\x1f") as [string, string, string];
        return { sha, at, message };
      });
  });
}

const relPath = (workspace: string, path: string) => relative(workspace, path).split(sep).join("/");

/** The page files of a design at a commit (no hidden files), as paths in the design folder. */
export async function designFilesAt(workspace: string, project: string, design: string, sha: string): Promise<string[]> {
  if (!isSha(sha)) throw new Error("Invalid commit id.");
  const dir = relPath(workspace, designDir(workspace, project, design));
  const out = await git(workspace, ["ls-tree", "-r", "--name-only", sha, "--", `${dir}/`]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((p) => p.slice(dir.length + 1))
    .filter((p) => p && !p.split("/").some((part) => part.startsWith(".")));
}

/** One file of a design at a commit, or null when it was not there. */
export async function designFileAt(workspace: string, project: string, design: string, sha: string, file: string): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!isSha(sha)) throw new Error("Invalid commit id.");
  const path = designFile(workspace, project, design, file);
  if (!path) return null;
  const result = await $`git show ${`${sha}:${relPath(workspace, path)}`}`.cwd(workspace).quiet().nothrow();
  return result.exitCode === 0 ? new Uint8Array(result.stdout) : null;
}
