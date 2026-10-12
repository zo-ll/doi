import { $ } from "bun";
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
 * Commits the design folder and the project's chat after a completed turn. Only these paths
 * go into the commit, so files the user staged elsewhere stay out of it. The commit uses the
 * user's own git identity. Returns the commit id, or null when nothing changed.
 */
export async function commitTurn(workspace: string, project: string, design: string, prompt: string): Promise<string | null> {
  const paths = [designDir(workspace, project, design)];
  const chat = chatFile(workspace, project);
  if (await Bun.file(chat).exists()) paths.push(chat);
  return serial(async () => {
    await git(workspace, ["add", "-A", "--", ...paths]);
    if (!(await git(workspace, ["diff", "--cached", "--name-only", "--", ...paths])).trim()) return null;
    await git(workspace, ["commit", "--quiet", "-m", commitMessage(prompt), "--", ...paths]);
    return (await git(workspace, ["rev-parse", "HEAD"])).trim();
  });
}
