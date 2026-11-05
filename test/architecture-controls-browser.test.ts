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
import { contrastRatio } from "../src/architecture/contrast.ts";
import { readArchitecture, writeArchitecture } from "../src/workspace/architecture.ts";

const hasBrowser = await chromium.launch().then(browser => browser.close().then(() => true), () => false);
test.if(!!process.env.CI)("CI has Chromium for the UML control cases", () => expect(hasBrowser).toBe(true));

test("the contrast ratio follows WCAG 2", () => {
  expect(contrastRatio("#000000", "#ffffff")).toBe(21);
  expect(contrastRatio("#777777", "#777777")).toBe(1);
  expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThan(4.5);
  expect(contrastRatio(null, "#ffffff")).toBeNull();
  expect(contrastRatio("transparent", "#ffffff")).toBeNull();
});

async function withEditor(run: (page: Page, saved: () => Promise<Diagram>) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "doi-uml-controls-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  const browser = await chromium.launch();
  try {
    const [a, b, c] = [["Alpha", 40, 80], ["Beta", 400, 80], ["Gamma", 400, 360]].map(([name, x, y]) => createNode("box", { x: Number(x), y: Number(y) }, String(name)));
    if (!a || !b || !c) throw new Error("Seed failed");
    await writeArchitecture(workspace, "sample", null, { version: 1, enabled: true, diagrams: [{ ...createDiagram(), nodes: [a, b, c], edges: [{ ...createEdge(a.id, b.id), label: "calls" }] }] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route("**/api/providers", route => route.fulfill({ json: [] }));
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${app.server.port}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "UML", exact: true }).click();
    await page.getByRole("button", { name: /System overview/ }).click();
    await page.getByRole("group", { name: "Alpha", exact: true }).waitFor();
    const saved = async () => {
      await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saved");
      const diagram = (await readArchitecture(workspace, "sample")).state.diagrams[0];
      if (!diagram) throw new Error("No diagram");
      return diagram;
    };
    await run(page, saved);
    expect(errors).toEqual([]);
  } finally { await browser.close(); app.stop(); await rm(workspace, { recursive: true, force: true }); }
}
const named = (d: Diagram, name: string) => { const n = d.nodes.find(x => x.name === name); if (!n) throw new Error(`No ${name}`); return n; };

test.skipIf(!hasBrowser)("U05: fill, border, text colour, text size and the contrast readout", async () => {
  await withEditor(async (page, saved) => {
    await page.getByRole("group", { name: "Alpha", exact: true }).click();
    await page.getByLabel("Fill", { exact: true }).fill("#ffffff");
    await page.getByLabel("Border", { exact: true }).fill("#ff0000");
    await page.getByLabel("Text colour", { exact: true }).fill("#999999");
    await page.getByRole("status").filter({ hasText: "Contrast 2.8:1: too low for small text (4.5:1 needed)" }).waitFor();
    await page.getByLabel("Text colour", { exact: true }).fill("#1d1c19");
    await page.getByRole("status").filter({ hasText: /^Contrast 1[67]\.\d:1$/ }).waitFor();
    await page.getByRole("spinbutton", { name: "Text size", exact: true }).fill("20");
    const style = named(await saved(), "Alpha").style;
    expect(style).toMatchObject({ fill: "#ffffff", stroke: "#ff0000", text: "#1d1c19", fontSize: 20 });
    const box = page.locator(".uml-node", { hasText: "Alpha" });
    expect(await box.evaluate(el => getComputedStyle(el).fontSize)).toBe("20px");
    expect(await box.evaluate(el => getComputedStyle(el).color)).toBe("rgb(29, 28, 25)");
  });
}, 45_000);

test.skipIf(!hasBrowser)("U08, U10, U11: route, bends, line, markers, labels and reverse direction", async () => {
  await withEditor(async (page, saved) => {
    await page.locator(".react-flow__edge").first().click({ force: true });
    await page.getByRole("combobox", { name: "Route", exact: true }).selectOption("curved");
    await page.getByRole("button", { name: "Add bend point", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Bend 1 X", exact: true }).fill("260");
    await page.getByRole("spinbutton", { name: "Bend 1 Y", exact: true }).fill("40");
    await page.getByRole("combobox", { name: "Line style", exact: true }).selectOption("dashed");
    await page.getByRole("combobox", { name: "Start marker", exact: true }).selectOption("diamond");
    await page.getByRole("combobox", { name: "End marker", exact: true }).selectOption("circle");
    await page.getByRole("textbox", { name: "Start label", exact: true }).fill("1");
    await page.getByRole("textbox", { name: "End label", exact: true }).fill("0..*");
    await page.getByRole("textbox", { name: "Connector label", exact: true }).fill("uses");
    let d = await saved();
    const alpha = named(d, "Alpha"), beta = named(d, "Beta");
    expect(d.edges[0]).toMatchObject({ source: alpha.id, target: beta.id, route: "curved", points: [{ x: 260, y: 40 }], line: "dashed", startMarker: "diamond", endMarker: "circle", startLabel: "1", endLabel: "0..*", label: "uses" });
    expect(await page.locator(".react-flow__edge path.react-flow__edge-path").first().evaluate(el => getComputedStyle(el).strokeDasharray)).not.toBe("none");
    await page.getByRole("button", { name: "Reverse direction", exact: true }).click();
    d = await saved();
    // The boxes swap and the multiplicities stay with their boxes; the markers stay at start and end, so the arrow head moves to the other box.
    expect(d.edges[0]).toMatchObject({ source: beta.id, target: alpha.id, startMarker: "diamond", endMarker: "circle", startLabel: "0..*", endLabel: "1", points: [{ x: 260, y: 40 }] });
  });
}, 45_000);

test.skipIf(!hasBrowser)("U07: reconnect an end with the pointer; the attachment follows a resize", async () => {
  await withEditor(async (page, saved) => {
    await page.locator(".react-flow__edge").first().click({ force: true });
    const end = await page.locator(".react-flow__edgeupdater-target").first().boundingBox();
    const target = await page.getByLabel("Connect top of Gamma", { exact: true }).boundingBox();
    if (!end || !target) throw new Error("Missing reconnect geometry");
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2); await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 15 }); await page.mouse.up();
    let d = await saved();
    const gamma = named(d, "Gamma");
    expect(d.edges[0]).toMatchObject({ target: gamma.id, targetSide: "top" });
    await page.getByRole("group", { name: "Gamma", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Width", exact: true }).fill("400");
    d = await saved();
    expect(named(d, "Gamma").size.width).toBe(400);
    expect(d.edges[0]).toMatchObject({ target: gamma.id, targetSide: "top", targetOffset: 0.5 });
    // The connector end sits at the middle of Gamma's new top edge.
    const box = await page.getByRole("group", { name: "Gamma", exact: true }).boundingBox();
    const tip = await page.locator(".react-flow__edge path.react-flow__edge-path").first().evaluate(el => {
      const path = el as SVGPathElement, point = path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM() ?? undefined);
      return { x: point.x, y: point.y };
    });
    if (!box) throw new Error("Missing geometry");
    const screenX = tip.x;
    expect(Math.abs(tip.y - box.y)).toBeLessThan(6);
    expect(Math.abs(screenX - (box.x + box.width / 2))).toBeLessThan(6);
  });
}, 45_000);

test.skipIf(!hasBrowser)("U15: zoom, pan and fit all move the viewport", async () => {
  await withEditor(async page => {
    const view = () => page.locator(".react-flow__viewport").evaluate(el => { const m = new DOMMatrix(getComputedStyle(el).transform); return { x: m.e, y: m.f, zoom: m.a }; });
    const start = await view();
    await page.locator(".react-flow__controls-zoomin").click();
    await page.waitForFunction(z => new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport") as Element).transform).a > z, start.zoom);
    const zoomed = await view();
    expect(zoomed.zoom).toBeGreaterThan(start.zoom);
    const pane = await page.locator(".uml-flow .react-flow__pane").boundingBox();
    if (!pane) throw new Error("No pane");
    await page.mouse.move(pane.x + 300, pane.y + 600); await page.mouse.down({ button: "right" });
    await page.mouse.move(pane.x + 420, pane.y + 650, { steps: 8 }); await page.mouse.up({ button: "right" });
    const panned = await view();
    expect(Math.round(panned.x - zoomed.x)).toBe(120);
    expect(Math.round(panned.y - zoomed.y)).toBe(50);
    await page.getByRole("button", { name: "Fit all", exact: true }).click();
    await page.waitForFunction(p => { const m = new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport") as Element).transform); return m.e !== p.x || m.f !== p.y; }, panned);
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      const box = await page.getByRole("group", { name, exact: true }).boundingBox();
      if (!box) throw new Error(`No ${name}`);
      expect(box.x).toBeGreaterThanOrEqual(pane.x);
      expect(box.y).toBeGreaterThanOrEqual(pane.y);
      expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width);
      expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height);
    }
  });
}, 45_000);
