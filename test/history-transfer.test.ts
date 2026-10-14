import { afterAll, beforeAll, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRepo, exportHistory, importHistory, rewriteStream } from "../src/workspace/git.ts";

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

const commit = (ws: string, msg: string) => $`git add -A && git commit -qm ${msg}`.cwd(ws).quiet();
const log = async (ws: string, path: string) => (await $`git log --format=%s -- ${path}`.cwd(ws).quiet().text()).trim().split("\n").filter(Boolean);

async function source() {
  const ws = await mkdtemp(join(tmpdir(), "doi-src-"));
  await ensureRepo(ws);
  await Bun.write(join(ws, "projects/a/designs/d/index.html"), "<h1>one</h1>");
  await Bun.write(join(ws, "projects/b/designs/d/index.html"), "<h1>b secret</h1>");
  await commit(ws, "First");
  await Bun.write(join(ws, "projects/a/designs/d/index.html"), "<h1>two</h1>\ndata 5\nprojects/a/ stays in file text");
  await commit(ws, "Second of a");
  await Bun.write(join(ws, "projects/b/designs/d/index.html"), "<h1>b two</h1>");
  await commit(ws, "Only b");
  return ws;
}

test("a project's history moves to another workspace under a new id; other projects stay out", async () => {
  const src = await source();
  const stream = (await exportHistory(src, ["projects/a"]))!;
  expect(new TextDecoder().decode(stream)).not.toContain("b secret");

  const dst = await mkdtemp(join(tmpdir(), "doi-dst-"));
  await ensureRepo(dst);
  await Bun.write(join(dst, "projects/a/designs/d/index.html"), "<h1>the other a</h1>");
  await commit(dst, "Own history");
  const r = await importHistory(dst, stream, [["projects/a/", "projects/a-2/"]], "Import project a");
  expect(r?.head).toMatch(/^[0-9a-f]{40}$/);
  expect(await log(dst, "projects/a-2/designs/d")).toEqual(["Second of a", "First"]);
  expect(await log(dst, "projects/a/designs/d")).toEqual(["Own history"]);
  // File text that looks like a path or a data line is not rewritten.
  expect(await Bun.file(join(dst, "projects/a-2/designs/d/index.html")).text()).toBe("<h1>two</h1>\ndata 5\nprojects/a/ stays in file text");
  expect(await Bun.file(join(dst, "projects/b/designs/d/index.html")).exists()).toBe(false);
  expect((await $`git for-each-ref refs/doi-import`.cwd(dst).quiet().text()).trim()).toBe(""); // no ref left
});

test("into a workspace without a commit", async () => {
  const src = await source();
  const dst = await mkdtemp(join(tmpdir(), "doi-dst-"));
  await ensureRepo(dst);
  await importHistory(dst, (await exportHistory(src, ["projects/a", "projects/b"]))!, [], "Import workspace");
  expect(await log(dst, "projects/b/designs/d")).toEqual(["Only b", "First"]);
  expect(await Bun.file(join(dst, "projects/a/designs/d/index.html")).exists()).toBe(true);
});

test("no history without git or without a commit; an empty stream imports nothing", async () => {
  const none = await mkdtemp(join(tmpdir(), "doi-none-"));
  expect(await exportHistory(none, ["projects"])).toBeNull();
  await ensureRepo(none);
  expect(await exportHistory(none, ["projects"])).toBeNull();
  expect(await importHistory(none, new Uint8Array(), [], "x")).toBeNull();
});

test("the rewrite changes refs and paths, also quoted ones, and never data blocks", () => {
  const s = new TextEncoder().encode('commit refs/heads/main\ndata 13\nprojects/a/ x\nM 100644 :1 projects/a/f\nM 100644 :2 "projects/a/sp ace"\nD projects/a/old\nM 100644 :3 projects/ab/f\n');
  const out = new TextDecoder().decode(rewriteStream(s, "refs/doi-import/x", [["projects/a/", "projects/z/"]]));
  expect(out).toBe('commit refs/doi-import/x\ndata 13\nprojects/a/ x\nM 100644 :1 projects/z/f\nM 100644 :2 "projects/z/sp ace"\nD projects/z/old\nM 100644 :3 projects/ab/f\n');
});

test("old commit ids map to the new ones; a data block that looks like a commit is not read", async () => {
  const src = await source();
  const old = (await $`git log --format=%H -- projects/a`.cwd(src).quiet().text()).trim().split("\n");
  const dst = await mkdtemp(join(tmpdir(), "doi-dst-"));
  await ensureRepo(dst);
  await Bun.write(join(dst, "x.txt"), "x");
  await commit(dst, "Own");
  const r = (await importHistory(dst, (await exportHistory(src, ["projects/a"]))!, [["projects/a/", "projects/n/"]], "Import"))!;
  const now = (await $`git log --format=%H -- projects/n`.cwd(dst).quiet().text()).trim().split("\n").filter((h) => h !== r.head);
  expect(old.map((h) => r.ids.get(h))).toEqual(now);
  const { originalIds } = await import("../src/workspace/git.ts");
  const fake = new TextEncoder().encode("blob\nmark :1\ndata 40\ncommit x\nmark :9\noriginal-oid aaaaaaaaaa\ncommit refs/heads/main\nmark :2\noriginal-oid " + "b".repeat(40) + "\ndata 1\nm\n");
  expect([...originalIds(fake)]).toEqual([[":2", "b".repeat(40)]]);
});

test("a dropped prefix leaves no file of it in the history", () => {
  const s = new TextEncoder().encode("commit refs/heads/main\nM 100644 :1 design-systems/ds/tokens.css\nM 100644 :2 projects/a/f\n");
  expect(new TextDecoder().decode(rewriteStream(s, "r", [["design-systems/ds/", null]]))).toBe("commit r\nM 100644 :2 projects/a/f\n");
});
