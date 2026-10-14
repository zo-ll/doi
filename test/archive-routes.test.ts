import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { postExport, postImport, postImportInspect } from "../src/server/archive.ts";
import { DesignLocks } from "../src/server/locks.ts";
import { listProjects } from "../src/workspace/paths.ts";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "doi-arch-routes-"));
  const ws = join(dir, "ws");
  await Bun.write(join(ws, "projects/shop/project.json"), JSON.stringify({ name: "Shop" }));
  await Bun.write(join(ws, "projects/shop/designs/home/index.html"), "<p>x</p>");
  const config = { ...(await loadConfig(join(dir, "config.toml"))), workspace: ws };
  config.prices = { "anthropic:m": { input: 3, output: 15 } };
  return { dir, ws, config, deps: { config, locks: new DesignLocks() } };
}
const json = (body: unknown) => new Request("http://x/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const zipReq = (bytes: Uint8Array<ArrayBuffer>, query = "") => new Request(`http://x/api/import${query}`, { method: "POST", headers: { "content-type": "application/zip" }, body: bytes });

test("export a project with settings and preferences, inspect it, import it with the settings", async () => {
  const a = await setup();
  const res = await postExport(a.deps, json({ kind: "project", project: "shop", settings: true, ui: { theme: "dark", panels: { chat: false, side: true }, lastDesign: { project: "shop", design: "home" }, extra: "<x>" } }));
  expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="shop-\d{4}-\d\d-\d\d\.doi\.zip"/);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const b = await setup(); // also has a "shop"
  const inspected = (await (await postImportInspect(b.deps, zipReq(bytes))).json()) as { manifest: { settings: { models: Record<string, string> }; ui: unknown }; projects: { to: string }[] };
  expect(inspected.projects[0]!.to).toBe("shop-2");
  expect(inspected.manifest.ui).toEqual({ theme: "dark", panels: { chat: false, side: true }, lastDesign: { project: "shop", design: "home" } });
  expect(inspected.manifest.settings.models.generate).toBe("claude-code:claude-opus-5-5");
  expect(JSON.stringify(inspected.manifest)).not.toContain("api_key");
  expect((await listProjects(b.ws)).map((p) => p.id)).toEqual(["shop"]); // inspect writes nothing

  b.config.prices = {};
  const r = (await (await postImport(b.deps, zipReq(bytes, "?settings=1"))).json()) as { settingsApplied: boolean; projects: { to: string }[] };
  expect(r.settingsApplied).toBe(true);
  expect(r.projects[0]!.to).toBe("shop-2");
  expect(b.config.prices).toEqual({ "anthropic:m": { input: 3, output: 15 } });
  expect(await Bun.file(join(b.dir, "config.toml")).text()).toContain('"anthropic:m" = { input = 3, output = 15 }');
  expect((await listProjects(b.ws)).map((p) => p.id)).toEqual(["shop", "shop-2"]);
});

test("without settings=1 the config stays; a bad body and a busy import are refused", async () => {
  const a = await setup();
  const bytes = new Uint8Array(await (await postExport(a.deps, json({ kind: "workspace", settings: true }))).arrayBuffer());
  const b = await setup();
  b.config.prices = {};
  const r = (await (await postImport(b.deps, zipReq(bytes))).json()) as { settingsApplied: boolean };
  expect(r.settingsApplied).toBe(false);
  expect(b.config.prices).toEqual({});
  expect(await Bun.file(join(b.dir, "config.toml")).exists()).toBe(false);
  expect((await postImport(b.deps, zipReq(new Uint8Array()))).status).toBe(400);
  expect((await postImport(b.deps, zipReq(new TextEncoder().encode("nope") as Uint8Array<ArrayBuffer>))).status).toBe(400);
  expect((await postExport(b.deps, json({ kind: "project", project: "../x" }))).status).toBe(400);
  expect((await postExport(b.deps, json({ kind: "project", project: "gone" }))).status).toBe(404);
  b.deps.locks.tryLock("import");
  expect((await postImport(b.deps, zipReq(bytes))).status).toBe(409);
});
