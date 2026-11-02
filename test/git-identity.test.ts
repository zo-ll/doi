import { $ } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitPaths, ensureRepo, exportHistory, FALLBACK_IDENTITY, identityEnv, importHistory } from "../src/workspace/git.ts";

// A computer where git was never set up: no global or system config, no identity variables.
const KEYS = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "EMAIL", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
const saved: Record<string, string | undefined> = {};
const GLOBAL = "[user]\n\tuseConfigOnly = true\n";
let globalConfig = "";

beforeAll(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  const home = await mkdtemp(join(tmpdir(), "doi-nohome-"));
  globalConfig = join(home, "global.gitconfig");
  // useConfigOnly: git must not build an identity from the passwd name and login@host, which
  // some machines have (a GECOS full name). Then "git was never set up" holds on every host.
  await writeFile(globalConfig, GLOBAL);
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" });
  for (const k of KEYS.slice(4)) delete process.env[k];
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "doi-ident-"));
  await ensureRepo(dir);
  await writeFile(join(dir, "a.txt"), "a\n");
  return dir;
}
const git = (dir: string, cmd: string[]) => $`git ${cmd}`.cwd(dir).env({ ...process.env }).quiet().nothrow();

describe("git identity", () => {
  test("without any git identity, a commit works under doi's name and writes no git config", async () => {
    const dir = await workspace();
    expect((await git(dir, ["var", "GIT_COMMITTER_IDENT"])).exitCode).not.toBe(0); // the setup has no identity
    const sha = await commitPaths(dir, [join(dir, "a.txt")], "First");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const who = `${FALLBACK_IDENTITY.name} <${FALLBACK_IDENTITY.email}>`;
    expect((await git(dir, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).stdout.toString().trim()).toBe(`${who}|${who}`); // no guess from the host
    expect((await git(dir, ["config", "--local", "user.name"])).stdout.toString().trim()).toBe("");
    expect((await git(dir, ["config", "--local", "user.email"])).stdout.toString().trim()).toBe("");
    expect(await readFile(globalConfig, "utf8")).toBe(GLOBAL); // the global config is unchanged too
  });

  test("an identity only in the global config wins", async () => {
    await writeFile(globalConfig, `${GLOBAL}\tname = Grace\n\temail = grace@example.com\n`);
    try {
      const dir = await workspace();
      expect(await identityEnv(dir)).toEqual({});
      await commitPaths(dir, [join(dir, "a.txt")], "Global");
      expect((await git(dir, ["log", "-1", "--format=%an <%ae>"])).stdout.toString().trim()).toBe("Grace <grace@example.com>");
    } finally {
      await writeFile(globalConfig, GLOBAL);
    }
  });

  test("without any git identity, an import merges its history under doi's name", async () => {
    const from = await workspace();
    await commitPaths(from, [join(from, "a.txt")], "Old work");
    const stream = await exportHistory(from, ["a.txt"]);
    expect(stream).not.toBeNull();
    const into = await workspace(); // it has a commit, so the import is a merge
    await writeFile(join(into, "b.txt"), "b\n");
    await commitPaths(into, [join(into, "b.txt")], "Here");
    const r = await importHistory(into, stream!, [["a.txt", "imported/a.txt"]], "Import project");
    expect(r?.head).toMatch(/^[0-9a-f]{40}$/);
    expect((await git(into, ["log", "-1", "--format=%s|%an"])).stdout.toString().trim()).toBe(`Import project|${FALLBACK_IDENTITY.name}`);
  });

  test("the user's own identity wins; when git refuses a partial one, only the missing part is doi's", async () => {
    const dir = await workspace();
    await git(dir, ["config", "user.name", "Ada"]);
    await git(dir, ["config", "user.email", "ada@example.com"]);
    expect(await identityEnv(dir)).toEqual({});
    await commitPaths(dir, [join(dir, "a.txt")], "Mine");
    expect((await git(dir, ["log", "-1", "--format=%an <%ae>"])).stdout.toString().trim()).toBe("Ada <ada@example.com>");

    await git(dir, ["config", "--unset", "user.email"]);
    // useConfigOnly (global): git does not guess the email, so a commit would fail
    const env = await identityEnv(dir);
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(env.GIT_AUTHOR_EMAIL).toBe(FALLBACK_IDENTITY.email);
  });
});
