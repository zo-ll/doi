import { expect, test } from "bun:test";
import { $ } from "bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpServer } from "../src/mcp/server.ts";
import { ensureRepo } from "../src/workspace/git.ts";
import { readArchitecture, writeArchitecture } from "../src/workspace/architecture.ts";
import { createDiagram, type Diagram } from "../src/architecture/schema.ts";
import { createNode } from "../src/architecture/nodes.ts";
import { createEdge } from "../src/architecture/edges.ts";

const renders: string[] = [];
async function withClient(run: (client: Client, ws: string) => Promise<void>) {
  const ws = await mkdtemp(join(tmpdir(), "doi-mcp-uml-"));
  await mkdir(join(ws, "projects", "shop"), { recursive: true });
  await ensureRepo(ws);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ workspace: ws, render: async (html, frames) => { renders.push(html); return frames.map(() => Buffer.from("png")); } }).connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  try { await run(client, ws); } finally { await client.close(); await rm(ws, { recursive: true, force: true }); }
}
const text = (r: any): string => r.content.find((c: { type: string }) => c.type === "text")?.text ?? "";
const parsed = (r: any) => JSON.parse(text(r));
function diagram(name: string): Diagram {
  const web = createNode("box", { x: 0, y: 0 }, "Web app"), api = createNode("box", { x: 300, y: 0 }, "API");
  return { ...createDiagram(), name, nodes: [web, api], edges: [{ ...createEdge(web.id, api.id), label: "calls" }] };
}

test("update_architecture writes with the editor's checks and records a version; it needs enabled UML", async () => {
  await withClient(async (client, ws) => {
    const call = (args: Record<string, unknown>) => client.callTool({ name: "update_architecture", arguments: { project: "shop", ...args } });
    const off = await call({ revision: null, diagram: diagram("Agent map") });
    expect(off.isError).toBe(true);
    expect(text(off)).toContain("UML is not enabled in this project");
    expect(await Bun.file(join(ws, "projects/shop/architecture.json")).exists()).toBe(false);

    const kept = { ...createDiagram(), name: "Kept" };
    let view = await writeArchitecture(ws, "shop", null, { version: 1, enabled: true, diagrams: [kept] });
    const created = parsed(await call({ revision: view.revision, diagram: diagram("Agent map") }));
    expect(created.created).toBe(true);
    expect(created.version).toMatch(/^[0-9a-f]{40}$/);
    view = await readArchitecture(ws, "shop");
    expect(view.revision).toBe(created.revision);
    expect(view.state.diagrams.map(d => d.name)).toEqual(["Kept", "Agent map"]);
    expect((await $`git log -1 --format=%s`.cwd(ws).text()).trim()).toBe("UML: agent: Agent map");

    const stale = await call({ revision: "0".repeat(64), diagram: { ...view.state.diagrams[1], name: "Lost" } });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("The UML changed since that revision");
    const map = view.state.diagrams[1]!;
    const bad = await call({ revision: view.revision, diagram: { ...map, nodes: [map.nodes[0], map.nodes[0]] } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toBe("The diagram is invalid. Box 2 id: Item ids must be unique.");
    const dangling = await call({ revision: view.revision, diagram: { ...map, nodes: [map.nodes[0]] } });
    expect(text(dangling)).toContain("Both connector endpoints must name existing boxes.");
    const replaced = parsed(await call({ revision: view.revision, diagram: { ...map, name: "Agent map 2" } }));
    expect(replaced.created).toBe(false);
    expect((await readArchitecture(ws, "shop")).state.diagrams.map(d => d.name)).toEqual(["Kept", "Agent map 2"]);
    expect((await client.callTool({ name: "update_architecture", arguments: { project: "../shop", revision: null, diagram: map } })).isError).toBe(true);
  });
});

test("render_architecture renders a diagram by id, name or default as a PNG", async () => {
  await withClient(async (client, ws) => {
    const off = await client.callTool({ name: "render_architecture", arguments: { project: "shop" } });
    expect(text(off)).toContain("UML is not enabled in this project");
    const first = diagram("First"), second = diagram("Second");
    await writeArchitecture(ws, "shop", null, { version: 1, enabled: true, diagrams: [first, second] });
    renders.length = 0;
    const result: any = await client.callTool({ name: "render_architecture", arguments: { project: "shop" } });
    expect(result.content[0]).toEqual({ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" });
    expect(text(result)).toStartWith("First (");
    expect(renders[0]).toContain("Web app");
    expect(renders[0]).toContain("calls");
    expect(renders[0]).toContain("@font-face");
    expect(text(await client.callTool({ name: "render_architecture", arguments: { project: "shop", diagram: "Second" } }))).toStartWith("Second (");
    expect(text(await client.callTool({ name: "render_architecture", arguments: { project: "shop", diagram: second.id, theme: "dark" } }))).toStartWith("Second (");
    const missing = await client.callTool({ name: "render_architecture", arguments: { project: "shop", diagram: "Nope" } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('Diagram "Nope" not found. Diagrams: First (');
  });
});

test("update_architecture names the diagram limit plainly", async () => {
  await withClient(async (client, ws) => {
    const view = await writeArchitecture(ws, "shop", null, { version: 1, enabled: true, diagrams: Array.from({ length: 50 }, (_, i) => ({ ...createDiagram(), name: `D${i}` })) });
    const full = await client.callTool({ name: "update_architecture", arguments: { project: "shop", revision: view.revision, diagram: diagram("One more") } });
    expect(full.isError).toBe(true);
    expect(text(full)).toBe("A project can have at most 50 UML diagrams. Replace a diagram instead of adding one.");
  });
});
