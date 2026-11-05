import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Page } from "playwright-core";
import { parseConfig } from "../src/config.ts";
import { startServer } from "../src/server/app.ts";
import { createDiagram } from "../src/architecture/schema.ts";
import { createNode } from "../src/architecture/nodes.ts";
import { createEdge } from "../src/architecture/edges.ts";
import { writeArchitecture } from "../src/workspace/architecture.ts";

const hasBrowser = await chromium.launch().then(browser => browser.close().then(() => true), () => false);
test.if(!!process.env.CI)("CI has Chromium for the UML image cases", () => expect(hasBrowser).toBe(true));

test.skipIf(!hasBrowser)("the Export image menu downloads SVG, PNG and PDF of the diagram or the selection", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "doi-uml-image-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  const browser = await chromium.launch();
  try {
    const web = createNode("box", { x: 0, y: 0 }, "Web app"), api = createNode("box", { x: 400, y: 0 }, "API service");
    await writeArchitecture(workspace, "sample", null, { version: 1, enabled: true, diagrams: [{ ...createDiagram(), nodes: [web, api], edges: [{ ...createEdge(web.id, api.id), label: "uses API" }] }] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, colorScheme: "light" });
    await context.route("**/api/providers", route => route.fulfill({ json: [] }));
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${app.server.port}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "UML", exact: true }).click();
    await page.getByRole("button", { name: /System overview/ }).click();
    await page.getByRole("group", { name: "Web app", exact: true }).waitFor();
    const menu = page.getByRole("group", { name: "Export image", exact: true });
    const open = async () => { if (!(await menu.isVisible())) await page.getByText("Export image", { exact: true }).click(); };
    const download = async (page: Page, label: string) => {
      const pending = page.waitForEvent("download");
      await menu.getByRole("button", { name: label, exact: true }).click();
      const file = await pending;
      return { name: file.suggestedFilename(), bytes: new Uint8Array(await readFile(await file.path())) };
    };

    await open();
    expect(await menu.getByRole("combobox", { name: "Colours", exact: true }).inputValue()).toBe("light");
    expect(await menu.locator("option[value=selection]").getAttribute("disabled")).not.toBeNull();
    await menu.getByRole("combobox", { name: "Format", exact: true }).selectOption("svg");
    const svg = await download(page, "Download SVG");
    expect(svg.name).toBe("System-overview.svg");
    const text = new TextDecoder().decode(svg.bytes);
    for (const part of ["Web app", "API service", "uses API", 'fill="#e8e6e1"']) expect(text).toContain(part);

    await menu.getByRole("combobox", { name: "Format", exact: true }).selectOption("png");
    const png = await download(page, "Download PNG");
    expect(png.name).toBe("System-overview.png");
    expect([...png.bytes.slice(1, 4)]).toEqual([80, 78, 71]);

    await page.keyboard.press("Escape");
    await page.getByRole("group", { name: "Web app", exact: true }).click();
    await open();
    await menu.getByRole("combobox", { name: "Scope", exact: true }).selectOption("selection");
    await menu.getByRole("combobox", { name: "Format", exact: true }).selectOption("svg");
    await menu.getByRole("checkbox", { name: "Background", exact: true }).uncheck();
    const part = new TextDecoder().decode((await download(page, "Download SVG")).bytes);
    expect(part).toContain("Web app");
    expect(part).not.toContain("API service");
    expect(part).not.toContain('fill="#e8e6e1"');

    await menu.getByRole("combobox", { name: "Format", exact: true }).selectOption("pdf");
    const pdf = await download(page, "Download PDF");
    expect(new TextDecoder().decode(pdf.bytes.slice(0, 5))).toBe("%PDF-");
    await page.getByText("Exported the selection as PDF.").waitFor();
    // An empty selection resets the scope; a new selection does not bring it back.
    await page.keyboard.press("Escape");
    await page.locator(".uml-flow .react-flow__pane").click({ position: { x: 30, y: 500 } });
    await page.getByRole("group", { name: "Web app", exact: true }).click();
    await open();
    expect(await menu.getByRole("combobox", { name: "Scope", exact: true }).inputValue()).toBe("all");
    expect(errors).toEqual([]);
  } finally { await browser.close(); app.stop(); await rm(workspace, { recursive: true, force: true }); }
}, 60_000);
