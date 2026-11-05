import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Page } from "playwright-core";
import { parseConfig } from "../src/config.ts";
import { startServer } from "../src/server/app.ts";
import { createDiagram, type Diagram } from "../src/architecture/schema.ts";
import { createNode } from "../src/architecture/nodes.ts";
import { createEdge } from "../src/architecture/edges.ts";
import { absolutePosition } from "../src/architecture/layout.ts";
import { readArchitecture, writeArchitecture } from "../src/workspace/architecture.ts";

const hasBrowser = await chromium.launch().then(browser => browser.close().then(() => true), () => false);
test.if(!!process.env.CI)("CI has Chromium for the UML tool cases", () => expect(hasBrowser).toBe(true));

async function withTools(run: (page: Page, saved: () => Promise<Diagram>) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "doi-uml-tools-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  const browser = await chromium.launch();
  try {
    const [a, b, c] = [["Alpha", 40, 40], ["Beta", 300, 90], ["Gamma", 620, 160]].map(([name, x, y]) => createNode("box", { x: Number(x), y: Number(y) }, String(name)));
    if (!a || !b || !c) throw new Error("Seed failed");
    await writeArchitecture(workspace, "sample", null, { version: 1, enabled: true, diagrams: [{ ...createDiagram(), nodes: [a, b, c], edges: [createEdge(a.id, b.id)] }] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
    await context.route("**/api/providers", route => route.fulfill({ json: [] }));
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${app.server.port}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "UML", exact: true }).click();
    await page.getByRole("button", { name: /System overview/ }).click();
    await page.getByRole("group", { name: "Alpha", exact: true }).waitFor();
    const saved = async () => {
      const save = page.getByRole("button", { name: "Save diagram", exact: true });
      if (await save.isEnabled()) await save.click();
      await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saved");
      const diagram = (await readArchitecture(workspace, "sample")).state.diagrams[0];
      if (!diagram) throw new Error("No saved diagram");
      return diagram;
    };
    await run(page, saved);
    expect(errors).toEqual([]);
  } finally { await browser.close(); app.stop(); await rm(workspace, { recursive: true, force: true }); }
}
const box = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
async function arrange(page: Page, label: string) {
  const menu = page.locator("details.uml-menu");
  if (await menu.getAttribute("open") === null) await page.getByText("Arrange", { exact: true }).click();
  await page.getByRole("group", { name: "Arrange", exact: true }).getByRole("button", { name: label, exact: true }).click();
}
const byName = (d: Diagram, name: string) => { const n = d.nodes.find(x => x.name === name); if (!n) throw new Error(`No ${name}`); return n; };

test.skipIf(!hasBrowser)("align, distribute and order change the saved graph", async () => {
  await withTools(async (page, saved) => {
    await box(page, "Alpha").click();
    await box(page, "Beta").click({ modifiers: ["Shift"] });
    await box(page, "Gamma").click({ modifiers: ["Shift"] });
    await arrange(page, "Align top");
    await arrange(page, "Distribute horizontally");
    await arrange(page, "Send to back");
    let d = await saved();
    expect(d.nodes.map(n => n.position.y)).toEqual([40, 40, 40]);
    const [alpha, beta, gamma] = ["Alpha", "Beta", "Gamma"].map(n => byName(d, n));
    if (!alpha || !beta || !gamma) throw new Error("Missing");
    expect(beta.position.x - (alpha.position.x + alpha.size.width)).toBe(gamma.position.x - (beta.position.x + beta.size.width));
    await page.keyboard.press("Escape");
    await box(page, "Alpha").click();
    await arrange(page, "Bring to front");
    d = await saved();
    expect(d.nodes.map(n => n.name)).toEqual(["Beta", "Gamma", "Alpha"]);
    expect(d.edges).toHaveLength(1);
  });
}, 30_000);

test.skipIf(!hasBrowser)("keyboard nudges, group and ungroup keep positions and connections", async () => {
  await withTools(async (page, saved) => {
    await box(page, "Alpha").click();
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ArrowDown");
    let d = await saved();
    expect(byName(d, "Alpha").position).toEqual({ x: 56, y: 41 });
    await box(page, "Beta").click({ modifiers: ["Shift"] });
    await page.keyboard.press("Control+g");
    d = await saved();
    const group = d.nodes.find(n => n.shape === "group");
    if (!group) throw new Error("No group");
    expect(byName(d, "Alpha").parent).toBe(group.id);
    expect(absolutePosition(d, byName(d, "Alpha").id)).toEqual({ x: 56, y: 41 });
    expect(absolutePosition(d, byName(d, "Beta").id)).toEqual({ x: 300, y: 90 });
    expect(d.edges).toHaveLength(1);
    await arrange(page, "Ungroup");
    d = await saved();
    expect(d.nodes.some(n => n.shape === "group")).toBe(false);
    expect(byName(d, "Alpha").position).toEqual({ x: 56, y: 41 });
    expect(byName(d, "Beta")).toMatchObject({ parent: null, position: { x: 300, y: 90 } });
    expect(d.edges).toHaveLength(1);
  });
}, 30_000);

test.skipIf(!hasBrowser)("copy, cut and paste use the system clipboard and new ids", async () => {
  await withTools(async (page, saved) => {
    await box(page, "Alpha").click();
    await box(page, "Beta").click({ modifiers: ["Shift"] });
    await page.keyboard.press("Control+c");
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(JSON.parse(text)).toMatchObject({ format: "doi-diagram-clipboard", version: 1 });
    await page.keyboard.press("Control+v");
    await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 5);
    let d = await saved();
    expect(d.nodes.map(n => n.name).toSorted()).toEqual(["Alpha", "Alpha", "Beta", "Beta", "Gamma"]);
    expect(new Set(d.nodes.map(n => n.id)).size).toBe(5);
    expect(d.edges).toHaveLength(2);
    const copies = d.nodes.filter(n => n.name === "Alpha").map(n => n.position);
    expect(copies).toContainEqual({ x: 64, y: 64 });
    await page.keyboard.press("Control+x");
    await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 3);
    await box(page, "Gamma").click();
    await page.keyboard.press("Control+v");
    await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 5);
    d = await saved();
    expect(d.nodes).toHaveLength(5);
    expect(d.edges).toHaveLength(2);
    const name = page.getByRole("textbox", { name: "Box name", exact: true });
    await box(page, "Gamma").click();
    await name.selectText();
    await page.keyboard.press("Control+c");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Gamma");
  });
}, 30_000);

test.skipIf(!hasBrowser)("a drag shows a guide and snaps to a sibling edge", async () => {
  await withTools(async (page, saved) => {
    const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const source = await box(page, "Gamma").boundingBox();
    if (!source) throw new Error("Missing box");
    // Gamma's top is at y 160; Beta's bottom is at y 180. Move Gamma down by 23 px, 3 px past the guide.
    await page.mouse.move(source.x + 20, source.y + 14); await page.mouse.down();
    for (const dy of [1, 8, 16, 23, 23.5]) { await page.mouse.move(source.x + 20, source.y + 14 + dy); await frame(); }
    await page.getByTestId("uml-guide").first().waitFor({ state: "attached" });
    await page.mouse.up();
    await page.getByTestId("uml-guide").first().waitFor({ state: "detached" });
    const d = await saved();
    expect(byName(d, "Gamma").position.y).toBe(byName(d, "Beta").position.y + byName(d, "Beta").size.height);
  });
}, 30_000);

test.skipIf(!hasBrowser)("fit selection zooms to the selected box", async () => {
  await withTools(async page => {
    const transform = () => page.locator(".react-flow__viewport").evaluate(el => getComputedStyle(el).transform);
    const before = await transform();
    await box(page, "Gamma").click();
    await page.getByRole("button", { name: "Fit selection", exact: true }).click();
    await page.waitForFunction(old => getComputedStyle(document.querySelector(".react-flow__viewport") as Element).transform !== old, before);
    const gamma = await box(page, "Gamma").boundingBox(), pane = await page.locator(".uml-flow").boundingBox();
    if (!gamma || !pane) throw new Error("Missing geometry");
    expect(Math.abs(gamma.x + gamma.width / 2 - (pane.x + pane.width / 2))).toBeLessThan(4);
  });
}, 30_000);

test.skipIf(!hasBrowser)("Snap off turns guides off", async () => {
  await withTools(async (page, saved) => {
    await page.getByRole("checkbox", { name: "Snap", exact: true }).uncheck();
    const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const source = await box(page, "Gamma").boundingBox();
    if (!source) throw new Error("Missing box");
    await page.mouse.move(source.x + 20, source.y + 14); await page.mouse.down();
    for (const dy of [1, 8, 16, 23, 23.5]) { await page.mouse.move(source.x + 20, source.y + 14 + dy); await frame(); }
    expect(await page.getByTestId("uml-guide").count()).toBe(0);
    await page.mouse.up();
    const y = byName(await saved(), "Gamma").position.y;
    expect(y).toBeGreaterThan(160);
    expect(y).not.toBe(180);
  });
}, 30_000);

test.skipIf(!hasBrowser)("locked boxes stay put through the arrange tools and cut", async () => {
  await withTools(async (page, saved) => {
    await box(page, "Alpha").click();
    await arrange(page, "Lock selection");
    expect(byName(await saved(), "Alpha").locked).toBe(true);
    await arrange(page, "Bring to front");
    await page.keyboard.press("Shift+ArrowRight");
    await box(page, "Beta").click({ modifiers: ["Shift"] });
    await page.getByText("Arrange", { exact: true }).click();
    expect(await page.getByRole("group", { name: "Arrange", exact: true }).getByRole("button", { name: "Align right", exact: true }).isDisabled()).toBe(true);
    await page.keyboard.press("Control+x");
    await page.getByRole("alert").filter({ hasText: "Unlock the selected boxes and the boxes in the selected groups before you cut them." }).waitFor();
    let d = await saved();
    expect(d.nodes.map(n => n.name)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(byName(d, "Alpha").position).toEqual({ x: 40, y: 40 });
    await page.keyboard.press("Escape");
    await box(page, "Alpha").click();
    await arrange(page, "Unlock selection");
    await page.keyboard.press("ArrowRight");
    d = await saved();
    expect(byName(d, "Alpha")).toMatchObject({ locked: false, position: { x: 41, y: 40 } });
  });
}, 30_000);

test.skipIf(!hasBrowser)("select all, delete, ungroup shortcut, undo and redo", async () => {
  await withTools(async (page, saved) => {
    await box(page, "Alpha").click();
    await box(page, "Beta").click({ modifiers: ["Shift"] });
    await page.keyboard.press("Control+g");
    await page.waitForFunction(() => document.querySelectorAll(".uml-node--group").length === 1);
    await page.keyboard.press("Control+Shift+g");
    await page.waitForFunction(() => document.querySelectorAll(".uml-node--group").length === 0);
    await page.keyboard.press("Control+z");
    await page.waitForFunction(() => document.querySelectorAll(".uml-node--group").length === 1);
    await page.keyboard.press("Control+Shift+z");
    await page.waitForFunction(() => document.querySelectorAll(".uml-node--group").length === 0);
    await page.keyboard.press("Control+a");
    expect(await page.locator(".uml-status").innerText()).toContain("4 selected");
    await page.keyboard.press("Delete");
    const d = await saved();
    expect(d.nodes).toEqual([]);
    expect(d.edges).toEqual([]);
  });
}, 30_000);

test.skipIf(!hasBrowser)("copy leaves a text selection and Ctrl+D without boxes to the app", async () => {
  await withTools(async page => {
    await box(page, "Alpha").click();
    await page.evaluate(() => navigator.clipboard.writeText("before"));
    const title = page.locator(".uml-canvas-header strong");
    await title.selectText();
    await page.keyboard.press("Control+c");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("System overview");
    await page.locator(".uml-flow .react-flow__pane").click({ position: { x: 20, y: 400 } });
    expect(await page.locator(".uml-status").innerText()).toContain("0 selected");
    await page.keyboard.press("Control+d");
    await page.getByRole("dialog", { name: "Design systems", exact: true }).waitFor();
  });
}, 30_000);

test.skipIf(!hasBrowser)("a locked child blocks a group cut; a group with its children is one arrange unit; a connector alone is not copied", async () => {
  await withTools(async (page, saved) => {
    await box(page, "Alpha").click();
    await box(page, "Beta").click({ modifiers: ["Shift"] });
    await page.keyboard.press("Control+g");
    await page.waitForFunction(() => document.querySelectorAll(".uml-node--group").length === 1);
    await page.keyboard.press("Escape");
    await box(page, "Alpha").click();
    await arrange(page, "Lock selection");
    await page.keyboard.press("Escape");
    await box(page, "Group").click({ position: { x: 12, y: 8 } });
    await page.keyboard.press("Control+x");
    await page.getByRole("alert").filter({ hasText: "Unlock the selected boxes and the boxes in the selected groups before you cut them." }).waitFor();
    expect(await page.locator(".react-flow__node").count()).toBe(4);
    await box(page, "Beta").click({ modifiers: ["Shift"] });
    await box(page, "Alpha").click({ modifiers: ["Shift"] });
    await page.getByText("Arrange", { exact: true }).click();
    const menu = page.getByRole("group", { name: "Arrange", exact: true });
    expect(await menu.getByRole("button", { name: "Align left", exact: true }).isDisabled()).toBe(true);
    await box(page, "Gamma").click({ modifiers: ["Shift"] });
    await page.getByText("Arrange", { exact: true }).click();
    expect(await menu.getByRole("button", { name: "Align left", exact: true }).isEnabled()).toBe(true);
    await page.keyboard.press("Escape");
    await page.locator(".react-flow__edge").first().click({ force: true });
    expect(await page.locator(".uml-status").innerText()).toContain("1 selected");
    await page.keyboard.press("Control+c");
    await page.getByRole("alert").filter({ hasText: "Select one or more boxes to copy." }).waitFor();
    expect((await saved()).nodes).toHaveLength(4);
  });
}, 30_000);
