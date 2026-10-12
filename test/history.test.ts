import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHistory, restoreVersion, type VersionView } from "../src/server/history.ts";
import { DesignLocks, designKey } from "../src/server/locks.ts";
import { appendChat, appendCommit, commitModels, readChat } from "../src/workspace/chat.ts";
import { commitPaths, commitTurn, designFileAt, designFilesAt, designLog, ensureRepo } from "../src/workspace/git.ts";
import { designDir } from "../src/workspace/paths.ts";

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

let ws: string;
let dir: string;
let locks: DesignLocks;
let open: boolean;
const params = { project: "p", design: "d" };
const deps = () => ({
  workspace: ws,
  locks,
  variantsOpen: async () => open,
  commit: (paths: string[], message: string) => commitPaths(ws, paths, message),
});
const write = (file: string, text: string) => Bun.write(join(dir, file), text);
const read = (file: string) => Bun.file(join(dir, file)).text();

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "doi-history-"));
  dir = designDir(ws, "p", "d");
  await mkdir(join(dir, "assets"), { recursive: true });
  await mkdir(designDir(ws, "p", "other"), { recursive: true });
  await ensureRepo(ws);
  locks = new DesignLocks();
  open = false;
  // Version 1: a page, a style, an image and comments.
  await write("index.html", '<h1 data-oid="t">One</h1>');
  await write("styles.css", "h1 { color: red; }");
  await Bun.write(join(dir, "assets", "dot.png"), new Uint8Array([137, 80, 78, 71, 0, 255]));
  await write(".comments.json", "[]\n");
  await commitTurn(ws, "p", "d", "First page");
  // Another design's commit is not in this history.
  await Bun.write(join(designDir(ws, "p", "other"), "index.html"), "<p>x</p>");
  await commitTurn(ws, "p", "other", "Other design");
  // Version 2: new text and a new file.
  await write("index.html", '<h1 data-oid="t">Two</h1>');
  await write("extra.css", "p {}");
  await commitTurn(ws, "p", "d", "Second page");
});

describe("version history", () => {
  test("the log lists the commits of the design, newest first", async () => {
    const log = await designLog(ws, "p", "d");
    expect(log.map((v) => v.message)).toEqual(["Second page", "First page"]);
    expect(log[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Date.parse(log[0]!.at)).not.toBeNaN();
  });

  test("files at a version: page files only, text and bytes, nothing outside", async () => {
    const [, first] = await designLog(ws, "p", "d");
    expect((await designFilesAt(ws, "p", "d", first!.sha)).sort()).toEqual(["assets/dot.png", "index.html", "styles.css"]);
    expect(new TextDecoder().decode((await designFileAt(ws, "p", "d", first!.sha, "index.html"))!)).toBe('<h1 data-oid="t">One</h1>');
    expect([...(await designFileAt(ws, "p", "d", first!.sha, "assets/dot.png"))!]).toEqual([137, 80, 78, 71, 0, 255]);
    expect(await designFileAt(ws, "p", "d", first!.sha, "extra.css")).toBeNull();
    expect(await designFileAt(ws, "p", "d", first!.sha, "../other/index.html")).toBeNull();
    await expect(designFileAt(ws, "p", "d", "HEAD; rm -rf", "index.html")).rejects.toThrow("Invalid commit id.");
  });

  test("each version names the model of the turn that made it, when known", async () => {
    const [second] = await designLog(ws, "p", "d");
    await appendChat(ws, "p", { role: "user", turn: "t2", design: "d", at: "", text: "Second page", target: null });
    await appendChat(ws, "p", {
      role: "assistant", turn: "t2", design: "d", at: "", text: "ok", status: "done",
      provider: "anthropic", model: "big", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, files: [], prompt: "v0",
    });
    await appendCommit(ws, "p", { turn: "t2", design: "d", sha: second!.sha });
    expect((await commitModels(ws, "p")).get(second!.sha)).toBe("anthropic:big");
    // The commit line is not a chat message.
    expect((await readChat(ws, "p", "d")).map((e) => e.role)).toEqual(["user", "assistant"]);
    const view = (await (await getHistory(deps(), params)).json()) as VersionView[];
    expect(view.map((v) => [v.message, v.model])).toEqual([["Second page", "anthropic:big"], ["First page", null]]);
  });

  test("restore puts the old files back as a new commit, and keeps the comments", async () => {
    const [, first] = await designLog(ws, "p", "d");
    await write(".comments.json", '[{"id":"c"}]\n');
    const res = await restoreVersion(deps(), { ...params, sha: first!.sha.slice(0, 7) });
    expect(res.status).toBe(200);
    expect((await res.json()).commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await read("index.html")).toBe('<h1 data-oid="t">One</h1>');
    expect(existsSync(join(dir, "extra.css"))).toBe(false);
    expect([...new Uint8Array(await Bun.file(join(dir, "assets", "dot.png")).arrayBuffer())]).toEqual([137, 80, 78, 71, 0, 255]);
    expect(await read(".comments.json")).toBe('[{"id":"c"}]\n');
    const log = await designLog(ws, "p", "d");
    expect(log.map((v) => v.message)).toEqual([`Restore ${first!.sha.slice(0, 7)}: First page`, "Second page", "First page"]);
  });

  test("restore is refused for bad or foreign versions, open variants and a running turn", async () => {
    const otherSha = (await designLog(ws, "p", "other"))[0]!.sha;
    const [, first] = await designLog(ws, "p", "d");
    expect((await restoreVersion(deps(), { ...params, sha: "nothex" })).status).toBe(400);
    expect((await restoreVersion(deps(), { ...params, sha: otherSha })).status).toBe(404);
    open = true;
    expect((await restoreVersion(deps(), { ...params, sha: first!.sha })).status).toBe(409);
    open = false;
    locks.tryLock(designKey("p", "d"));
    expect((await restoreVersion(deps(), { ...params, sha: first!.sha })).status).toBe(409);
    expect(await read("index.html")).toBe('<h1 data-oid="t">Two</h1>');
    expect((await getHistory(deps(), { project: "p", design: "nope" })).status).toBe(404);
  });
});
