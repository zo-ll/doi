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
      expect(await page.locator('iframe[sandbox="allow-scripts"]').first().getAttribute("src")).toContain("/other/about.html");
      expect(new URL(page.url()).searchParams.get("node")).toBe("target");
    } finally { gate.resolve(); await loaded; }
  });
}, 15000);

test.skipIf(!hasBrowser)("the open diagram row preserves dirty ownership and the leave warning", async () => {
  await withEditor(async (page, workspace) => {
    const dialogs: string[] = [], errors: string[] = [];
    page.on("dialog", dialog => { dialogs.push(dialog.message()); dialog.accept().catch(error => errors.push(String(error))); });
    await page.getByRole("textbox", { name: "Box name", exact: true }).fill("Unsaved name");
    await page.getByRole("button", { name: /System overview/ }).click();
    expect(dialogs).toEqual([]);
    expect(await page.getByRole("textbox", { name: "Box name", exact: true }).inputValue()).toBe("Unsaved name");
    expect(await page.getByRole("button", { name: "Hide UML", exact: true }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "← Back to UI design", exact: true }).click();
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toContain("discard unsaved edits");
    expect((await readArchitecture(workspace, "sample")).state.diagrams[0]?.nodes[0]?.name).toBe("Saved name");
    expect(errors).toEqual([]);
  });
}, 15000);
