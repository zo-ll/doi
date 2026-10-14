import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneDir, excludeClones, ghStatus, listRepos, syncClone, viewRepo, type GhDeps, type GhResult } from "../src/github/gh.ts";

/** A fake gh and git: answers by the command, and records the calls. */
function fake(answer: (cmd: string[], cwd?: string) => Partial<GhResult> | Promise<Partial<GhResult>>, which: string | null = "/usr/bin/gh") {
  const calls: { cmd: string[]; cwd?: string }[] = [];
  const deps: GhDeps = {
    which: () => which,
    async run(cmd, options = {}) {
      calls.push({ cmd, cwd: options.cwd });
      return { code: 0, stdout: "", stderr: "", ...(await answer(cmd, options.cwd)) };
    },
  };
  return { deps, calls };
}

test("status reads only the exit code of gh auth status", async () => {
  expect(await ghStatus(fake(() => ({}), null).deps)).toEqual({ installed: false, loggedIn: false });
  expect(await ghStatus(fake(() => ({ code: 0, stdout: "Logged in to github.com account someone (keyring)" })).deps)).toEqual({ installed: true, loggedIn: true });
  expect(await ghStatus(fake(() => ({ code: 1 })).deps)).toEqual({ installed: true, loggedIn: false });
});

test("repo list: valid names only, newest first", async () => {
  const json = JSON.stringify([
    { nameWithOwner: "me/old", description: null, isPrivate: false, primaryLanguage: null, updatedAt: "2026-01-01T00:00:00Z" },
    { nameWithOwner: "me/app", description: "The app", isPrivate: true, primaryLanguage: { name: "TypeScript" }, updatedAt: "2026-10-01T00:00:00Z" },
    { nameWithOwner: "bad name", updatedAt: "2026-10-02T00:00:00Z" },
  ]);
  const { deps, calls } = fake(() => ({ stdout: json }));
  expect(await listRepos(deps)).toEqual([
    { name: "me/app", description: "The app", private: true, language: "TypeScript", updatedAt: "2026-10-01T00:00:00Z" },
    { name: "me/old", description: "", private: false, language: null, updatedAt: "2026-01-01T00:00:00Z" },
  ]);
  expect(calls[0]!.cmd.slice(0, 3)).toEqual(["gh", "repo", "list"]);
  await expect(listRepos(fake(() => ({ code: 1, stderr: "HTTP 401\nnot logged in" })).deps)).rejects.toThrow("gh repo list failed: not logged in");
});

test("a repo by name: checked before gh runs; a repo gh cannot see is a 404", async () => {
  const { deps, calls } = fake(() => ({ code: 1 }));
  await expect(viewRepo("--help", deps)).rejects.toThrow("is not a repo name");
  await expect(viewRepo("a/b;rm -rf", deps)).rejects.toThrow("is not a repo name");
  expect(calls).toHaveLength(0);
  await expect(viewRepo("org/secret", deps)).rejects.toMatchObject({ status: 404 });
});

test("clones live in the workspace cache, one folder per repo", () => {
  expect(cloneDir("/ws", "Me/App.js")).toBe("/ws/.repos/me/app.js");
  expect(() => cloneDir("/ws", "../x")).toThrow();
});

test("sync: a shallow clone first, then fetch and reset of the cache copy", async () => {
  const ws = await mkdtemp(join(tmpdir(), "doi-gh-"));
  const { deps, calls } = fake(async (cmd) => {
    if (cmd[1] === "repo" && cmd[2] === "clone") {
      await mkdir(join(cmd[4]!, ".git"), { recursive: true });
      await Bun.write(join(cmd[4]!, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    return cmd[1] === "rev-parse" ? { stdout: "abc123\n" } : {};
  });
  expect(await syncClone(ws, "me/app", deps)).toBe("abc123");
  expect(calls[0]!.cmd).toEqual(["gh", "repo", "clone", "me/app", join(ws, ".repos/me/app"), "--", "--depth", "1", "--single-branch", "--quiet"]);
  calls.length = 0;
  await syncClone(ws, "me/app", deps);
  expect(calls.map((c) => c.cmd.slice(0, 3).join(" "))).toEqual(["git fetch --depth", "git reset --hard", "git clean -fdxq", "git rev-parse HEAD"]);
  expect(calls.every((c) => c.cwd === join(ws, ".repos/me/app"))).toBe(true);
});

test("a failed clone leaves no folder", async () => {
  const ws = await mkdtemp(join(tmpdir(), "doi-gh-"));
  const { deps } = fake(async (cmd) => {
    if (cmd[2] === "clone") {
      await mkdir(join(cmd[4]!, "partial"), { recursive: true });
      return { code: 1, stderr: "fatal: repository not found" };
    }
    return {};
  });
  await expect(syncClone(ws, "me/gone", deps)).rejects.toThrow("gh repo clone failed: fatal: repository not found");
  expect(await Bun.file(join(ws, ".repos/me/gone/partial")).exists()).toBe(false);
});

test("the clones are excluded from the workspace git, once", async () => {
  const ws = await mkdtemp(join(tmpdir(), "doi-gh-"));
  await Bun.write(join(ws, ".git", "HEAD"), "ref: refs/heads/main\n");
  await Bun.write(join(ws, ".git", "info", "exclude"), "# git ls-files --others --exclude-from=.git/info/exclude");
  await excludeClones(ws);
  await excludeClones(ws);
  expect(await Bun.file(join(ws, ".git", "info", "exclude")).text()).toBe("# git ls-files --others --exclude-from=.git/info/exclude\n/.repos/\n");
});
