import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Page } from "playwright-core";
import { parseConfig } from "../src/config.ts";
import { startServer } from "../src/server/app.ts";
import { createDiagram } from "../src/architecture/schema.ts";
import { createNode } from "../src/architecture/nodes.ts";
import { readArchitecture, writeArchitecture } from "../src/workspace/architecture.ts";

const hasBrowser = await chromium.launch().then(browser => browser.close().then(() => true), () => false);
test.if(!!process.env.CI)("CI has Chromium for the UML review cases", () => expect(hasBrowser).toBe(true));
async function withEditor(run: (page: Page, workspace: string, base: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "doi-uml-review-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  const browser = await chromium.launch();
  try {
    const other = join(workspace, "projects/sample/designs/other");
    await mkdir(other, { recursive: true });
    await Bun.write(join(other, "index.html"), '<html><body><h1 data-oid="target">Other index</h1></body></html>');
    await Bun.write(join(other, "about.html"), '<html><body><h1 data-oid="target">Other about</h1></body></html>');
    const node = createNode("box", { x: 80, y: 80 }, "Saved name");
    node.references.push({ design: "other", page: "about.html", node: "target" });
    await writeArchitecture(workspace, "sample", null, { version: 1, enabled: true, diagrams: [{ ...createDiagram(), nodes: [node] }] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route("**/api/providers", route => route.fulfill({ json: [] }));
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    const base = `http://127.0.0.1:${app.server.port}`;
    await page.goto(`${base}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "UML", exact: true }).click();
    await page.getByRole("button", { name: /System overview/ }).click();
    await page.getByRole("group", { name: "Saved name", exact: true }).click();
    await run(page, workspace, base);
  } finally { await browser.close(); app.stop(); await rm(workspace, { recursive: true, force: true }); }
}

test.skipIf(!hasBrowser)("invalid fields and files show plain rules without a write", async () => {
  await withEditor(async (page, workspace) => {
    const name = page.getByRole("textbox", { name: "Box name", exact: true });
    await name.fill("");
    await page.getByRole("button", { name: "Save diagram", exact: true }).click();
    expect(await page.getByRole("alert").innerText()).toBe("Box 1 name: Enter a value.");
    expect(await name.getAttribute("required")).not.toBeNull();
    expect(await name.getAttribute("maxlength")).toBe("200");
    expect(await name.getAttribute("aria-invalid")).toBe("true");
    expect(await page.getByRole("textbox", { name: "Box content", exact: true }).getAttribute("maxlength")).toBe("20000");
    await page.getByRole("button", { name: "Export JSON", exact: true }).click();
    expect(await page.getByRole("alert").innerText()).toBe("Box 1 name: Enter a value.");
    await name.fill("Saved name");
    const node = createNode("box", { x: 0, y: 0 });
    const payload = JSON.stringify({ format: "doi-diagram", version: 1, diagram: { ...createDiagram(), nodes: [node, node] } });
    await page.getByLabel("Import JSON", { exact: true }).setInputFiles({ name: "duplicate.json", mimeType: "application/json", buffer: Buffer.from(payload) });
    await page.getByRole("alert").filter({ hasText: "Item ids must be unique." }).waitFor();
    expect(await page.getByRole("alert").innerText()).toBe("Box 2 id: Item ids must be unique.");
    expect((await readArchitecture(workspace, "sample")).state.diagrams[0]?.nodes[0]?.name).toBe("Saved name");
    expect((await readArchitecture(workspace, "sample")).state.diagrams).toHaveLength(1);
  });
}, 15000);

test.skipIf(!hasBrowser)("a cross-design UI link keeps its page while the target list loads", async () => {
  await withEditor(async page => {
    const gate = Promise.withResolvers<void>();
    await page.route("**/api/projects/sample/designs/other/pages?*", async route => { await gate.promise; await route.continue(); });
    const loaded = page.waitForResponse(response => new URL(response.url()).pathname === "/api/projects/sample/designs/other/pages", { timeout: 5000 }).then(() => true, () => false);
    try {
      await page.locator(".uml-ui-reference button").first().click();
      await page.waitForURL(url => url.searchParams.get("design") === "other");
      expect(new URL(page.url()).searchParams.get("page")).toBe("about.html");
      gate.resolve(); expect(await loaded).toBe(true);
      expect(await page.getByTitle("Pages in this design", { exact: true }).innerText()).toContain("about.html");
      // The design has two pages, so each has a frame; the link names the second one.
      await page.locator('iframe[sandbox="allow-scripts"][src*="/other/about.html"]').first().waitFor({ state: "attached" });
      expect(new URL(page.url()).searchParams.get("node")).toBe("target");
    } finally { gate.resolve(); await loaded; }
  });
}, 15000);

test.skipIf(!hasBrowser)("the open diagram row keeps edits; Back asks before it drops an edit that cannot save", async () => {
  await withEditor(async (page, workspace) => {
    const dialogs: string[] = [], errors: string[] = [];
    page.on("dialog", dialog => { dialogs.push(dialog.message()); dialog.accept().catch(error => errors.push(String(error))); });
    const name = page.getByRole("textbox", { name: "Box name", exact: true });
    await name.fill("Unsaved name");
    await page.getByRole("button", { name: /System overview/ }).click();
    expect(dialogs).toEqual([]);
    expect(await name.inputValue()).toBe("Unsaved name");
    await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saved");
    expect((await readArchitecture(workspace, "sample")).state.diagrams[0]?.nodes[0]?.name).toBe("Unsaved name");
    await name.fill("");
    await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Not saved");
    await page.getByRole("button", { name: "← Back to UI design", exact: true }).click();
    await page.getByRole("region", { name: "UML editor", exact: true }).waitFor({ state: "detached" });
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toContain("discard unsaved edits");
    expect((await readArchitecture(workspace, "sample")).state.diagrams[0]?.nodes[0]?.name).toBe("Unsaved name");
    expect(errors).toEqual([]);
  });
}, 15000);

test.skipIf(!hasBrowser)("an imported diagram with a used name gets a distinct name", async () => {
  await withEditor(async (page, workspace) => {
    const payload = JSON.stringify({ format: "doi-diagram", version: 1, diagram: { ...createDiagram(), nodes: [createNode("box", { x: 0, y: 0 }, "Imported")] } });
    await page.getByLabel("Import JSON", { exact: true }).setInputFiles({ name: "same.json", mimeType: "application/json", buffer: Buffer.from(payload) });
    await page.getByRole("group", { name: "Imported", exact: true }).waitFor();
    expect((await readArchitecture(workspace, "sample")).state.diagrams.map(d => d.name)).toEqual(["System overview", "System overview copy"]);
  });
}, 15000);

test.skipIf(!hasBrowser)("edits continue during a pending save and the next autosave stores them", async () => {
  await withEditor(async (page, workspace) => {
    const gate = Promise.withResolvers<void>();
    let puts = 0;
    await page.route("**/api/projects/sample/architecture", async route => { if (route.request().method() === "PUT" && ++puts === 1) await gate.promise; await route.continue(); });
    try {
      const name = page.getByRole("textbox", { name: "Box name", exact: true });
      await name.fill("First edit");
      await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saving…");
      expect(await page.locator(".react-flow__resize-control").count()).toBeGreaterThan(0);
      expect(await name.isEditable()).toBe(true);
      await name.fill("Second edit");
      gate.resolve();
      await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saved");
      expect((await readArchitecture(workspace, "sample")).state.diagrams[0]?.nodes[0]?.name).toBe("Second edit");
      expect(puts).toBe(2);
    } finally { gate.resolve(); }
  });
}, 15000);

test.skipIf(!hasBrowser)("a diagram removed elsewhere closes the editor without a reload", async () => {
  await withEditor(async (page, workspace) => {
    const { revision } = await readArchitecture(workspace, "sample");
    await writeArchitecture(workspace, "sample", revision, { version: 1, enabled: true, diagrams: [{ ...createDiagram(), name: "Other diagram" }] });
    await page.getByText("The open diagram is no longer in this project.").waitFor();
    expect(await page.getByRole("region", { name: "UML editor", exact: true }).count()).toBe(0);
    expect(await page.getByText("Load the UML diagram…").count()).toBe(0);
  });
}, 15000);

test.skipIf(!hasBrowser)("a pending UML write from the panel does not block chat on the UI canvas", async () => {
  await withEditor(async page => {
    await page.getByRole("button", { name: "← Back to UI design", exact: true }).click();
    const gate = Promise.withResolvers<void>();
    await page.route("**/api/projects/sample/architecture", async route => { if (route.request().method() === "PUT") await gate.promise; await route.continue(); });
    try {
      await page.getByRole("button", { name: "Hide UML", exact: true }).click();
      await page.getByRole("button", { name: "Hide UML", exact: true }).and(page.locator(":disabled")).waitFor();
      expect(await page.getByRole("textbox", { name: "Message", exact: true }).isEnabled()).toBe(true);
    } finally { gate.resolve(); }
  });
}, 15000);

test.skipIf(!hasBrowser)("UML hidden elsewhere closes the editor with a plain message", async () => {
  await withEditor(async (page, workspace) => {
    const { revision, state } = await readArchitecture(workspace, "sample");
    await writeArchitecture(workspace, "sample", revision, { ...state, enabled: false });
    await page.getByText("UML is hidden in this project. Your diagrams are kept.").waitFor();
    expect(await page.getByRole("region", { name: "UML editor", exact: true }).count()).toBe(0);
  });
}, 15000);

test.skipIf(!hasBrowser)("other diagram rows are disabled while a save is pending", async () => {
  await withEditor(async (page, workspace) => {
    const { revision, state } = await readArchitecture(workspace, "sample");
    await writeArchitecture(workspace, "sample", revision, { ...state, diagrams: [...state.diagrams, { ...createDiagram(), name: "Second diagram" }] });
    await page.getByRole("button", { name: "Load latest", exact: true }).click();
    await page.getByRole("button", { name: /Second diagram/ }).waitFor();
    await page.getByRole("group", { name: "Saved name", exact: true }).click();
    const gate = Promise.withResolvers<void>();
    await page.route("**/api/projects/sample/architecture", async route => { if (route.request().method() === "PUT") await gate.promise; await route.continue(); });
    try {
      await page.getByRole("textbox", { name: "Box name", exact: true }).fill("Pending name");
      await page.getByRole("button", { name: "Save diagram", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saving…");
      expect(await page.getByRole("button", { name: /Second diagram/ }).isDisabled()).toBe(true);
      gate.resolve();
      await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saved");
      expect(await page.getByRole("button", { name: /Second diagram/ }).isEnabled()).toBe(true);
    } finally { gate.resolve(); }
  });
}, 15000);

test.skipIf(!hasBrowser)("a stale save pauses autosave and keeps the local edit", async () => {
  await withEditor(async (page, workspace) => {
    // The save is in flight when the other write lands, so the server answers 409.
    const gate = Promise.withResolvers<void>();
    let puts = 0;
    await page.route("**/api/projects/sample/architecture", async route => { if (route.request().method() === "PUT" && ++puts === 1) await gate.promise; await route.continue(); });
    try {
      await page.getByRole("textbox", { name: "Box name", exact: true }).fill("Stale write");
      await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saving…");
      const { revision, state } = await readArchitecture(workspace, "sample");
      const [diagram] = state.diagrams;
      if (!diagram) throw new Error("The diagram is missing.");
      await writeArchitecture(workspace, "sample", revision, { ...state, diagrams: [{ ...diagram, nodes: diagram.nodes.map(n => ({ ...n, name: "Other write" })) }] });
      gate.resolve();
      await page.getByRole("region", { name: "UML editor", exact: true }).getByRole("alert").filter({ hasText: "changed elsewhere" }).waitFor();
      expect(await page.locator(".uml-save-state").innerText()).toBe("Not saved: changed elsewhere");
      await page.getByRole("textbox", { name: "Box name", exact: true }).fill("Stale write 2");
      await page.waitForTimeout(1500);
      expect(puts).toBe(1);
      expect(await page.getByRole("textbox", { name: "Box name", exact: true }).inputValue()).toBe("Stale write 2");
      expect((await readArchitecture(workspace, "sample")).state.diagrams[0]?.nodes[0]?.name).toBe("Other write");
    } finally { gate.resolve(); }
  });
}, 15000);
