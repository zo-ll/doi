import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getArchitecture, putArchitecture } from "../src/server/architecture.ts";
import { MAX_ARCHITECTURE_BYTES } from "../src/workspace/architecture.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
async function fixture() { const r = await mkdtemp(join(tmpdir(), "doi-uml-api-")); roots.push(r); await mkdir(join(r, "projects/test"), { recursive: true }); return r; }
const request = (body: unknown) => new Request("http://localhost/", { method: "PUT", body: JSON.stringify(body) });

test("the UML API distinguishes read, save, stale, invalid and missing requests", async () => {
  const root = await fixture();
  const initial = await (await getArchitecture(root, "test")).json();
  expect((await putArchitecture(root, "test", request({ ...initial, state: { ...initial.state, enabled: true } }))).status).toBe(200);
  expect((await putArchitecture(root, "test", request(initial))).status).toBe(409);
  expect((await putArchitecture(root, "test", request({ version: 2 }))).status).toBe(400);
  expect((await putArchitecture(root, "test", new Request("http://localhost/", { method: "PUT", body: "{" }))).status).toBe(400);
  expect((await getArchitecture(root, "gone")).status).toBe(404);
});

test("the UML API bounds a streamed body without trusting Content-Length", async () => {
  const root = await fixture();
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_ARCHITECTURE_BYTES + 1)); c.close(); } });
  const response = await putArchitecture(root, "test", new Request("http://localhost/", { method: "PUT", body: stream }));
  expect(response.status).toBe(413);
  expect(await Bun.file(join(root, "projects/test/architecture.json")).exists()).toBe(false);
});
