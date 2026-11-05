import { expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig } from "../src/config.ts";
import { startServer } from "../src/server/app.ts";
import { createDiagram } from "../src/architecture/schema.ts";
import { createNode } from "../src/architecture/nodes.ts";

async function withApp(run: (base: string, workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "doi-uml-history-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  try { await run(`http://127.0.0.1:${app.server.port}/api/projects/sample/architecture`, workspace); }
  finally { app.stop(); await rm(workspace, { recursive: true, force: true }); }
}
const json = { "content-type": "application/json" };

test("a checkpoint records a version; versions list and read the saved graphs", async () => {
  await withApp(async (base, workspace) => {
    const empty = await (await fetch(`${base}/versions`)).json();
    expect(empty).toEqual({ versions: [] });
    const diagram = { ...createDiagram(), nodes: [createNode("box", { x: 0, y: 0 }, "First")] };
    let view = await (await fetch(base, { method: "PUT", headers: json, body: JSON.stringify({ revision: null, state: { version: 1, enabled: true, diagrams: [diagram] } }) })).json();
    const checkpoint = (label: string) => fetch(`${base}/checkpoint`, { method: "POST", headers: json, body: JSON.stringify({ label }) });
    const first = await (await checkpoint("System overview")).json();
    expect(first.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await (await checkpoint("System overview")).json()).toEqual({ sha: null });
    const renamed = { ...diagram, nodes: [{ ...diagram.nodes[0], name: "Second" }] };
    view = await (await fetch(base, { method: "PUT", headers: json, body: JSON.stringify({ revision: view.revision, state: { ...view.state, diagrams: [renamed] } }) })).json();
    expect(view.state.diagrams[0].nodes[0].name).toBe("Second");
    const second = await (await checkpoint("System overview")).json();
    const { versions } = await (await fetch(`${base}/versions`)).json();
    expect(versions.map((v: { sha: string }) => v.sha)).toEqual([second.sha, first.sha]);
    expect(versions[0].message).toBe("UML: System overview");
    const old = await (await fetch(`${base}/versions/${first.sha}`)).json();
    expect(old.state.diagrams[0].nodes[0].name).toBe("First");
    // Only the UML file is in the commit.
    const files = (await $`git show --name-only --format= ${second.sha}`.cwd(workspace).text()).trim();
    expect(files).toBe("projects/sample/architecture.json");
  });
});

test("version routes reject bad ids, unknown versions, bad labels and other origins", async () => {
  await withApp(async base => {
    expect((await fetch(`${base}/versions/not-a-sha`)).status).toBe(400);
    expect((await fetch(`${base}/versions/${"a".repeat(40)}`)).status).toBe(404);
    expect((await fetch(`${base}/checkpoint`, { method: "POST", headers: json, body: JSON.stringify({ label: "" }) })).status).toBe(400);
    expect((await fetch(`${base}/checkpoint`, { method: "POST", headers: json, body: JSON.stringify({ label: "x", extra: 1 }) })).status).toBe(400);
    expect((await fetch(`${base}/checkpoint`, { method: "POST", headers: { ...json, origin: "https://evil.example" }, body: JSON.stringify({ label: "x" }) })).status).toBe(403);
    expect(await (await fetch(`${base}/checkpoint`, { method: "POST", headers: json, body: JSON.stringify({ label: "Nothing saved" }) })).json()).toEqual({ sha: null });
    expect((await fetch(base.replace("/sample/", "/missing/") + "/versions")).status).toBe(404);
  });
});
