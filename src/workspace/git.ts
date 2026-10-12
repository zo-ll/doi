import { $ } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chatFile } from "./chat.ts";
import { designDir } from "./paths.ts";

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

/** Commits the design folder and the project's chat after a completed turn. */
export function commitTurn(workspace: string, project: string, design: string, prompt: string): Promise<string | null> {
  return commitPaths(workspace, [designDir(workspace, project, design), chatFile(workspace, project)], prompt);
}
