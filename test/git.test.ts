import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitMessage, commitPaths, commitTurn, designVersion, ensureRepo } from "../src/workspace/git.ts";
import { rename } from "node:fs/promises";
import { designDir } from "../src/workspace/paths.ts";

// A test identity in a private global config: the commit must use it, so doi sets none itself.
const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "doi-gitcfg-"));
  await Bun.write(join(home, "gitconfig"), "[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function workspace() {
  const ws = await mkdtemp(join(tmpdir(), "doi-git-"));
  for (const design of ["home", "about"]) {
    const dir = designDir(ws, "p", design);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "index.html"), `<h1>${design}</h1>`);
  }
  await ensureRepo(ws);
  return ws;
}
const git = (ws: string) => (strings: TemplateStringsArray, ...v: Bun.ShellExpression[]) => $(strings, ...v).cwd(ws).quiet().text();

describe("git history", () => {
  test("the workspace becomes its own repo once", async () => {
    const ws = await workspace();
    expect(await Bun.file(join(ws, ".git", "HEAD")).exists()).toBe(true);
    await ensureRepo(ws); // a second call changes nothing
    expect((await $`git rev-parse --show-toplevel`.cwd(ws).quiet().text()).trim()).toEndWith(ws.split("/").pop()!);
  });

  test("a turn commits its design and the chat, with the prompt and the user's identity", async () => {
    const ws = await workspace();
    await Bun.write(join(ws, "projects", "p", "chat.jsonl"), "{}\n");
    const sha = await commitTurn(ws, "p", "home", "  Make the title blue\nand bigger  ");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const log = await git(ws)`git log -1 --format=%an%n%ae%n%s HEAD`;
    expect(log.trim().split("\n")).toEqual(["Test Person", "test@example.com", "Make the title blue"]);
    await mkdir(join(ws, "projects", "p", "uploads"));
    await Bun.write(join(ws, "projects", "p", "uploads", "a.png"), "png");
    await Bun.write(join(designDir(ws, "p", "home"), "index.html"), "<h1>2</h1>");
    await commitTurn(ws, "p", "home", "second");
    expect((await git(ws)`git show --name-only --format= HEAD`).trim().split("\n").sort()).toEqual([
      "projects/p/designs/home/index.html",
      "projects/p/uploads/a.png",
    ]);
    const files = (await git(ws)`git show --name-only --format= HEAD~1`).trim().split("\n").sort();
    expect(files).toEqual(["projects/p/chat.jsonl", "projects/p/designs/home/index.html"]);
  });

  test("nothing new gives no commit", async () => {
    const ws = await workspace();
    await commitTurn(ws, "p", "home", "first");
    expect(await commitTurn(ws, "p", "home", "again")).toBeNull();
    expect((await git(ws)`git rev-list --count HEAD`).trim()).toBe("1");
  });

  test("files the user staged elsewhere stay out of the commit and stay staged", async () => {
    const ws = await workspace();
    await commitTurn(ws, "p", "home", "first");
    await Bun.write(join(designDir(ws, "p", "about"), "index.html"), "<h1>changed by hand</h1>");
    await $`git add projects/p/designs/about/index.html`.cwd(ws).quiet();
    await Bun.write(join(designDir(ws, "p", "home"), "index.html"), "<h1>home 2</h1>");
    await commitTurn(ws, "p", "home", "second");
    expect((await git(ws)`git show --name-only --format= HEAD`).trim()).toBe("projects/p/designs/home/index.html");
    expect((await git(ws)`git diff --cached --name-only`).trim()).toBe("projects/p/designs/about/index.html");
  });

  test("two commits at the same time both succeed", async () => {
    const ws = await workspace();
    const [a, b] = await Promise.all([commitTurn(ws, "p", "home", "home"), commitTurn(ws, "p", "about", "about")]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect((await git(ws)`git rev-list --count HEAD`).trim()).toBe("2");
  });

  test("a moved folder is committed as a rename; an unknown gone path is skipped", async () => {
    const ws = await workspace();
    await commitTurn(ws, "p", "home", "first");
    await rename(designDir(ws, "p", "home"), designDir(ws, "p", "start"));
    const never = designDir(ws, "p", "never-existed");
    await commitPaths(ws, [designDir(ws, "p", "home"), designDir(ws, "p", "start"), never], "Rename design home to start");
    const status = (await git(ws)`git show --name-status --format= -M HEAD`).trim();
    expect(status).toMatch(/^R100\tprojects\/p\/designs\/home\/index.html\tprojects\/p\/designs\/start\/index.html$/);
  });

  test("a git failure throws with git's message", async () => {
    const ws = await mkdtemp(join(tmpdir(), "doi-nogit-"));
    await mkdir(designDir(ws, "p", "home"), { recursive: true });
    await expect(commitTurn(ws, "p", "home", "x")).rejects.toThrow(/git [a-z-]+ failed: .*not a git repository/);
  });

  test("the message is the first line, trimmed and short", () => {
    expect(commitMessage("  hello  \nworld")).toBe("hello");
    expect(commitMessage("   ")).toBe("Design change");
    expect(commitMessage("x".repeat(100))).toHaveLength(72);
  });

  test("designVersion is the last commit of the design folder, or null", async () => {
    const ws = await workspace();
    expect(await designVersion(ws, "p", "home")).toBeNull();
    const home = await commitTurn(ws, "p", "home", "home");
    await commitTurn(ws, "p", "about", "about");
    // The later commit of "about" is not a version of "home".
    expect(await designVersion(ws, "p", "home")).toBe(home);
  });
});
