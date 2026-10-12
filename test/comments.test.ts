import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteCommentRoute, getComments, patchComment, postComment, type CommentView } from "../src/server/comments.ts";
import { commentsFile } from "../src/workspace/comments.ts";
import { designDir } from "../src/workspace/paths.ts";

let ws: string;
let dir: string;
const deps = () => ({ workspace: ws, version: async () => "f".repeat(40) });
const params = { project: "p", design: "d" };
const req = (body: unknown) => new Request("http://x/", { method: "POST", body: JSON.stringify(body) });

const post = async (body: unknown, p = params) => postComment(deps(), req(body), p);
const list = async (p = params) => (await (await getComments(deps(), p)).json()) as CommentView[];
const patch = (id: string, body: unknown) => patchComment(deps(), req(body), { ...params, id });

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "doi-comments-"));
  dir = designDir(ws, "p", "d");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "index.html"), '<main data-oid="main"><button data-oid="cta">Buy</button></main>');
});

describe("comments", () => {
  test("a comment is stored with its element, text, status and design version", async () => {
    expect(await list()).toEqual([]);
    const res = await post({ oid: "cta", text: "  Make it bigger  " });
    expect(res.status).toBe(201);
    const c = (await res.json()) as CommentView;
    expect(c).toMatchObject({ oid: "cta", text: "Make it bigger", status: "open", version: "f".repeat(40), detached: false });
    expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await list()).toEqual([c]);
    const stored = await Bun.file(commentsFile(ws, "p", "d")).json();
    expect(stored).toEqual([{ id: c.id, oid: "cta", text: "Make it bigger", status: "open", version: "f".repeat(40), createdAt: c.createdAt }]);
  });

  test("bad requests are refused", async () => {
    for (const body of [{ oid: "cta" }, { oid: "cta", text: " " }, { oid: "bad id", text: "x" }, { text: "x" }, [], "x"]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await post({ oid: "cta", text: "x".repeat(5001) })).status).toBe(400);
    const missing = await post({ oid: "nothing", text: "x" });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe('No element has data-oid "nothing" in this design.');
    expect((await post({ oid: "cta", text: "x" }, { project: "p", design: "nope" })).status).toBe(404);
    expect((await post({ oid: "cta", text: "x" }, { project: "p", design: "../x" })).status).toBe(400);
    expect(await list()).toEqual([]);
  });

  test("a comment on an element that no longer exists is detached", async () => {
    await post({ oid: "cta", text: "Bigger" });
    await Bun.write(join(dir, "index.html"), '<main data-oid="main"><a data-oid="link">Buy</a></main>');
    expect((await list()).map((c) => c.detached)).toEqual([true]);
    // It comes back when the element comes back.
    await Bun.write(join(dir, "index.html"), '<main data-oid="main"><button data-oid="cta">Buy</button></main>');
    expect((await list()).map((c) => c.detached)).toEqual([false]);
  });

  test("done and open again, a new text, and delete", async () => {
    const { id } = (await (await post({ oid: "cta", text: "Bigger" })).json()) as CommentView;
    const done = (await (await patch(id, { status: "done" })).json()) as CommentView;
    expect(done.status).toBe("done");
    expect(done.doneAt).toBeString();
    const open = (await (await patch(id, { status: "open", text: "Much bigger" })).json()) as CommentView;
    expect(open).toMatchObject({ status: "open", text: "Much bigger" });
    expect(open.doneAt).toBeUndefined();
    expect((await patch(id, { status: "closed" })).status).toBe(400);
    expect((await patch(id, {})).status).toBe(400);
    expect((await patch("nope", { status: "done" })).status).toBe(404);

    expect((await deleteCommentRoute(deps(), { ...params, id })).status).toBe(204);
    expect((await deleteCommentRoute(deps(), { ...params, id })).status).toBe(404);
    expect(await list()).toEqual([]);
  });

  test("comments written at the same time are all kept", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => post({ oid: "cta", text: `c${i}` })));
    expect((await list()).map((c) => c.text).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `c${i}`).sort());
  });

  test("a file that is not valid JSON is an error and is not overwritten", async () => {
    await Bun.write(commentsFile(ws, "p", "d"), "{ broken");
    expect((await getComments(deps(), params)).status).toBe(500);
    expect((await post({ oid: "cta", text: "x" })).status).toBe(500);
    expect(await Bun.file(commentsFile(ws, "p", "d")).text()).toBe("{ broken");
  });

  test("a comment on a design that moved away gets 404 and does not make the folder again", async () => {
    await rename(dir, designDir(ws, "p", "e"));
    expect((await post({ oid: "cta", text: "x" })).status).toBe(404);
    expect(await Bun.file(join(dir, ".comments.json")).exists()).toBe(false);
    expect(await list({ project: "p", design: "e" })).toEqual([]);
  });
});
