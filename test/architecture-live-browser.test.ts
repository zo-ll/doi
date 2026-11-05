import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Page } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseConfig } from "../src/config.ts";
import { startServer } from "../src/server/app.ts";
import { createDiagram } from "../src/architecture/schema.ts";
import { createNode } from "../src/architecture/nodes.ts";
import { readArchitecture, writeArchitecture } from "../src/workspace/architecture.ts";

const hasBrowser = await chromium.launch().then(browser => browser.close().then(() => true), () => false);
test.if(!!process.env.CI)("CI has Chromium for the UML live cases", () => expect(hasBrowser).toBe(true));

async function withEditor(run: (page: Page, workspace: string, base: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "doi-uml-live-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  const browser = await chromium.launch();
  try {
    await writeArchitecture(workspace, "sample", null, { version: 1, enabled: true, diagrams: [{ ...createDiagram(), nodes: [createNode("box", { x: 80, y: 80 }, "Start")] }] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route("**/api/providers", route => route.fulfill({ json: [] }));
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    const base = `http://127.0.0.1:${app.server.port}`;
    await page.goto(`${base}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "UML", exact: true }).click();
    await page.getByRole("button", { name: /System overview/ }).click();
    await page.getByRole("group", { name: "Start", exact: true }).waitFor();
    await run(page, workspace, base);
    expect(errors).toEqual([]);
  } finally { await browser.close(); app.stop(); await rm(workspace, { recursive: true, force: true }); }
}
async function rename(workspace: string, name: string) {
  const { revision, state } = await readArchitecture(workspace, "sample");
  const [diagram] = state.diagrams;
  if (!diagram) throw new Error("No diagram");
  await writeArchitecture(workspace, "sample", revision, { ...state, diagrams: [{ ...diagram, nodes: diagram.nodes.map(n => ({ ...n, name })) }] });
}

test.skipIf(!hasBrowser)("an agent's MCP update shows on the open canvas without a reload, and Undo reverses it", async () => {
  await withEditor(async (page, workspace, base) => {
    const client = new Client({ name: "agent", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const view = JSON.parse((await client.callTool({ name: "get_architecture", arguments: { project: "sample" } }) as { content: { text: string }[] }).content[0]!.text);
      const diagram = view.state.diagrams[0];
      const extra = createNode("box", { x: 400, y: 80 }, "From agent");
      const result = await client.callTool({ name: "update_architecture", arguments: { project: "sample", revision: view.revision, diagram: { ...diagram, nodes: [...diagram.nodes, extra] } } });
      expect(result.isError).toBeFalsy();
    } finally { await client.close(); }
    await page.getByRole("group", { name: "From agent", exact: true }).waitFor();
    await page.getByText("Updated from another window or an agent. Undo reverses it.").waitFor();
    expect(await page.locator(".uml-save-state").innerText()).toBe("Saved");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByRole("group", { name: "From agent", exact: true }).waitFor({ state: "detached" });
    await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saved");
    expect((await readArchitecture(workspace, "sample")).state.diagrams[0]?.nodes).toHaveLength(1);
  });
}, 45_000);

test.skipIf(!hasBrowser)("an outside change while local edits wait stops autosave and keeps both", async () => {
  await withEditor(async (page, workspace) => {
    await page.getByRole("group", { name: "Start", exact: true }).click();
    const name = page.getByRole("textbox", { name: "Box name", exact: true });
    // An empty name cannot save: the edit stays local.
    await name.fill("");
    await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Not saved");
    await rename(workspace, "Agent name");
    await page.getByRole("region", { name: "UML editor", exact: true }).getByText("The diagram changed elsewhere. Your edits are not saved.").waitFor();
    expect(await page.locator(".uml-save-state").innerText()).toBe("Not saved: changed elsewhere");
    await name.fill("Local name");
    await page.waitForTimeout(1500);
    expect(await name.inputValue()).toBe("Local name");
    expect((await readArchitecture(workspace, "sample")).state.diagrams[0]?.nodes[0]?.name).toBe("Agent name");
  });
}, 45_000);

test.skipIf(!hasBrowser)("the editor's own autosave is not taken for an outside change", async () => {
  await withEditor(async (page, workspace) => {
    await page.getByRole("group", { name: "Start", exact: true }).click();
    const name = page.getByRole("textbox", { name: "Box name", exact: true });
    for (const text of ["One", "Two", "Three"]) {
      await name.fill(text);
      await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saved");
    }
    await page.waitForTimeout(800);
    expect(await page.locator(".uml-notice").count()).toBe(0);
    expect((await readArchitecture(workspace, "sample")).state.diagrams[0]?.nodes[0]?.name).toBe("Three");
  });
}, 45_000);

test.skipIf(!hasBrowser)("a draft survives an outside removal and is saved before an outside hide closes the editor", async () => {
  await withEditor(async (page, workspace) => {
    await page.getByRole("group", { name: "Start", exact: true }).click();
    const name = page.getByRole("textbox", { name: "Box name", exact: true });
    await name.fill("Draft after removal");
    const before = await readArchitecture(workspace, "sample");
    await writeArchitecture(workspace, "sample", before.revision, { ...before.state, diagrams: [] });
    await page.waitForFunction(async () => { const r = await fetch("/api/projects/sample/architecture"); const v = await r.json(); return v.state.diagrams[0]?.nodes[0]?.name === "Draft after removal"; });
    expect(await page.getByRole("region", { name: "UML editor", exact: true }).count()).toBe(1);
    expect(await name.inputValue()).toBe("Draft after removal");

    await name.fill("Draft before hide");
    const current = await readArchitecture(workspace, "sample");
    await writeArchitecture(workspace, "sample", current.revision, { ...current.state, enabled: false });
    await page.getByText("UML is hidden in this project. Your diagrams are kept.").waitFor();
    const hidden = await readArchitecture(workspace, "sample");
    expect(hidden.state.enabled).toBe(false);
    expect(hidden.state.diagrams[0]?.nodes[0]?.name).toBe("Draft before hide");
  });
}, 45_000);

test.skipIf(!hasBrowser)("a late answer of an older refresh does not replace a newer one", async () => {
  await withEditor(async (page, workspace) => {
    const gate = Promise.withResolvers<void>();
    let gets = 0;
    // Hold the answer, not the request: the late answer then carries the older file.
    await page.route("**/api/projects/sample/architecture", async route => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      if (++gets === 1) await gate.promise;
      await route.fulfill({ response });
    });
    try {
      await rename(workspace, "First agent");
      for (let i = 0; i < 40 && gets < 1; i++) await Bun.sleep(50);
      await rename(workspace, "Second agent");
      await page.getByRole("group", { name: "Second agent", exact: true }).waitFor();
      gate.resolve();
      await Bun.sleep(600);
      expect(await page.getByRole("group", { name: "Second agent", exact: true }).count()).toBe(1);
      expect(await page.getByRole("group", { name: "First agent", exact: true }).count()).toBe(0);
      expect(gets).toBe(2);
    } finally { gate.resolve(); }
  });
}, 45_000);

test.skipIf(!hasBrowser)("a rename of the open diagram from the panel is not an outside change", async () => {
  await withEditor(async page => {
    page.on("dialog", dialog => void dialog.accept("Renamed in the panel"));
    await page.locator('summary[aria-label="Actions for System overview"]').click();
    await page.locator(".uml-diagram-row").getByRole("button", { name: "Rename", exact: true }).click();
    await page.locator(".uml-canvas-header strong", { hasText: "Renamed in the panel" }).waitFor();
    await page.waitForTimeout(600);
    expect(await page.getByText("Updated from another window or an agent.").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Undo", exact: true }).isDisabled()).toBe(true);
  });
}, 45_000);
