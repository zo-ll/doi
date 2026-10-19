import { $ } from "bun";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
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

/** Lines a commit added and removed in one file of a design. Binary files count 0. */
export interface FileStat {
  file: string;
  add: number;
  del: number;
}

/**
 * The changed files of some commits, inside one design folder, with one git call. A commit
 * that is not in the repo (a reset, another clone) has no entry.
 */
export async function commitStats(workspace: string, project: string, design: string, shas: string[]): Promise<Map<string, FileStat[]>> {
  const out = new Map<string, FileStat[]>();
  const valid = shas.filter(isSha);
  if (!valid.length) return out;
  const prefix = relative(workspace, designDir(workspace, project, design)).split(sep).join("/") + "/";
  let text: string;
  try {
    // --no-walk: each commit only, not its parents; --ignore-missing: skip a commit that is gone.
    // One "@<sha>" line, then one numstat line per file.
    text = await serial(() => git(workspace, ["log", "--no-walk", "--ignore-missing", "--numstat", "--format=@%H", ...valid, "--", prefix]));
  } catch {
    return out; // a missing commit: no counts, the chat still loads
  }
  let current: FileStat[] | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("@")) {
      current = [];
      const full = line.slice(1);
      const asked = valid.find((s) => full.startsWith(s));
      if (asked) out.set(asked, current);
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m || !current || !m[3]!.startsWith(prefix)) continue;
    current.push({ file: m[3]!.slice(prefix.length), add: m[1] === "-" ? 0 : Number(m[1]), del: m[2] === "-" ? 0 : Number(m[2]) });
  }
  return out;
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

/** The folders directly under `dir` that commit `sha` deleted files from (a picked variant set). */
export function deletedFolders(workspace: string, sha: string, dir: string): Promise<string[]> {
  if (!isSha(sha)) throw new Error("Invalid commit id.");
  const rel = relPath(workspace, dir);
  return serial(async () => {
    const out = await git(workspace, ["diff-tree", "-r", "--no-commit-id", "--name-only", "--diff-filter=D", sha, "--", `${rel}/`]);
    const names = out.split("\n").filter(Boolean).map((p) => p.slice(rel.length + 1).split("/")[0]!);
    return [...new Set(names.filter(Boolean))];
  });
}

/** The files under `dir` that commit `sha` changed, as paths in `dir`. */
export function changedFiles(workspace: string, sha: string, dir: string): Promise<string[]> {
  if (!isSha(sha)) throw new Error("Invalid commit id.");
  const rel = relPath(workspace, dir);
  return serial(async () => {
    // -z: paths as written, not quoted (git quotes non-ASCII names in its normal output).
    const out = await git(workspace, ["diff-tree", "-r", "-z", "--no-commit-id", "--name-only", sha, "--", `${rel}/`]);
    return out.split("\0").filter(Boolean).map((p) => p.slice(rel.length + 1));
  });
}

/** Puts a folder back as it was in the parent of commit `sha`. The caller commits it. */
export function checkoutBefore(workspace: string, sha: string, dir: string): Promise<void> {
  if (!isSha(sha)) throw new Error("Invalid commit id.");
  const rel = relPath(workspace, dir);
  return serial(async () => {
    await git(workspace, ["checkout", `${sha}^`, "--", `${rel}/`]);
  });
}

/** One file of a design at a commit, or null when it was not there. */
export async function designFileAt(workspace: string, project: string, design: string, sha: string, file: string): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!isSha(sha)) throw new Error("Invalid commit id.");
  const path = designFile(workspace, project, design, file);
  if (!path) return null;
  const result = await $`git show ${`${sha}:${relPath(workspace, path)}`}`.cwd(workspace).quiet().nothrow();
  return result.exitCode === 0 ? new Uint8Array(result.stdout) : null;
}

/**
 * The history of some paths as a `git fast-export` stream (#114): only the commits that touch
 * them, and only their files. Null without git or without a commit.
 */
export async function exportHistory(workspace: string, paths: string[]): Promise<Uint8Array | null> {
  if (!(await Bun.file(join(workspace, ".git", "HEAD")).exists())) return null;
  return serial(async () => {
    const head = await $`git rev-parse --verify --quiet HEAD`.cwd(workspace).quiet().nothrow();
    if (head.exitCode !== 0) return null;
    const r = await $`git fast-export --signed-tags=strip --tag-of-filtered-object=drop --reencode=yes --show-original-ids HEAD -- ${paths}`.cwd(workspace).quiet().nothrow();
    if (r.exitCode !== 0) throw new Error(`git fast-export failed: ${r.stderr.toString().trim()}`);
    return new Uint8Array(r.stdout);
  });
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Rewrites a fast-export stream for an import: the branch becomes `ref`, and path prefixes
 * change for renamed projects and design systems (`projects/a/` → `projects/a-2/`); a prefix
 * renamed to null is dropped. The stream is parsed: `data` blocks (file contents, messages)
 * are copied byte for byte.
 */
export function rewriteStream(stream: Uint8Array, ref: string, renames: [from: string, to: string | null][]): Uint8Array {
  const out: Uint8Array[] = [];
  const rename = (path: string): string | null => {
    for (const [from, to] of renames) if (path.startsWith(from)) return to === null ? null : to + path.slice(from.length);
    return path;
  };
  /** A path field: plain, or C-quoted. Our prefixes are plain ASCII, so the quoted form starts the same. */
  const renamePath = (field: string): string | null => {
    const quoted = field.startsWith('"');
    const p = rename(quoted ? field.slice(1) : field);
    return p === null ? null : quoted ? `"${p}` : p;
  };
  let i = 0;
  while (i < stream.length) {
    let end = stream.indexOf(10, i);
    if (end < 0) end = stream.length;
    const line = dec.decode(stream.subarray(i, end));
    const next = end + 1;
    if (line.startsWith("data ")) {
      const size = Number(line.slice(5));
      if (!Number.isInteger(size) || size < 0) throw new Error("The history stream is broken (data).");
      out.push(stream.subarray(i, Math.min(stream.length, next + size)));
      i = next + size;
      continue;
    }
    let text: string | null = line;
    if (/^(commit|reset) /.test(line)) text = `${line.split(" ")[0]} ${ref}`;
    else if (line.startsWith("M ")) {
      const [m, mode, dataref, ...rest] = line.split(" ");
      const path = renamePath(rest.join(" "));
      text = path === null ? null : [m, mode, dataref, path].join(" ");
    } else if (line.startsWith("D ")) {
      const path = renamePath(line.slice(2));
      text = path === null ? null : `D ${path}`;
    }
    if (text !== null) out.push(enc.encode(text), new Uint8Array([10]));
    i = next;
  }
  const total = out.reduce((n, b) => n + b.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const b of out) {
    all.set(b, at);
    at += b.length;
  }
  return all;
}

/** The commit marks of a fast-export stream with `--show-original-ids`: mark → the commit id it had. */
export function originalIds(stream: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let inCommit = false;
  let mark: string | null = null;
  let i = 0;
  while (i < stream.length) {
    let end = stream.indexOf(10, i);
    if (end < 0) end = stream.length;
    const line = dec.decode(stream.subarray(i, end));
    i = end + 1;
    if (line.startsWith("data ")) {
      i += Number(line.slice(5)) || 0; // file text or a message: never read as commands
      inCommit = false;
      continue;
    }
    if (line.startsWith("commit ")) {
      inCommit = true;
      mark = null;
    } else if (inCommit && line.startsWith("mark ")) mark = line.slice(5);
    else if (inCommit && line.startsWith("original-oid ") && mark) out.set(mark, line.slice(13));
  }
  return out;
}

export interface ImportedHistory {
  /** The workspace HEAD after the import. */
  head: string;
  /** Old commit id → new commit id, for the commit lines of chat.jsonl. */
  ids: Map<string, string>;
}

/**
 * Adds a history stream to the workspace: `git fast-import` into a temporary ref, then a merge
 * of that unrelated history, so `git log -- <path>` finds the imported commits. The paths must
 * be new in the workspace. Returns null for a stream without commits.
 */
export async function importHistory(
  workspace: string,
  stream: Uint8Array,
  renames: [string, string | null][],
  message: string,
): Promise<ImportedHistory | null> {
  if (!stream.length) return null;
  const ref = `refs/doi-import/${crypto.randomUUID()}`;
  const marks = join(workspace, ".git", `doi-import-${crypto.randomUUID()}.marks`);
  return serial(async () => {
    const proc = Bun.spawn(["git", "fast-import", "--quiet", `--export-marks=${marks}`], { cwd: workspace, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(rewriteStream(stream, ref, renames));
    await proc.stdin.end();
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    try {
      if (code !== 0) throw new Error(`git fast-import failed: ${err.trim().split("\n").at(-1)}`);
      const has = await $`git rev-parse --verify --quiet ${ref}`.cwd(workspace).quiet().nothrow();
      if (has.exitCode !== 0) return null; // no commits in the stream
      const head = await $`git rev-parse --verify --quiet HEAD`.cwd(workspace).quiet().nothrow();
      if (head.exitCode !== 0) {
        // A workspace without a commit: the import is its first history.
        await git(workspace, ["reset", "--quiet", ref]);
        await git(workspace, ["checkout", "--quiet", "--", "."]);
      } else {
        await git(workspace, ["merge", "--quiet", "--allow-unrelated-histories", "--no-edit", "-m", message, ref]);
      }
      const original = originalIds(stream);
      const ids = new Map<string, string>();
      for (const line of (await Bun.file(marks).text().catch(() => "")).split("\n")) {
        const [mark, sha] = line.split(" ");
        const old = mark ? original.get(mark) : undefined;
        if (old && sha) ids.set(old, sha);
      }
      return { head: (await git(workspace, ["rev-parse", "HEAD"])).trim(), ids };
    } finally {
      await $`git update-ref -d ${ref}`.cwd(workspace).quiet().nothrow();
      await rm(marks, { force: true });
    }
  });
}
