import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { parseConfig } from "../src/config.ts";
import { startServer } from "../src/server/app.ts";
import { shapeSchema } from "../src/architecture/nodes.ts";
import { readArchitecture } from "../src/workspace/architecture.ts";

const hasBrowser = await chromium.launch().then(browser => browser.close().then(() => true), () => false);
test.if(!!process.env.CI)("CI has Chromium for the UML lifecycle cases", () => expect(hasBrowser).toBe(true));

test.skipIf(!hasBrowser)("every shape and every diagram lifecycle control works and persists", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "doi-uml-lifecycle-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route("**/api/providers", route => route.fulfill({ json: [] }));
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    const answers: (string | boolean)[] = [];
    const dialogs: string[] = [];
    page.on("dialog", dialog => { dialogs.push(dialog.message()); const answer = answers.shift(); void (answer === false ? dialog.dismiss() : dialog.accept(typeof answer === "string" ? answer : undefined)); });
    const saved = async () => (await readArchitecture(workspace, "sample")).state;
    const row = (name: string) => page.locator(".uml-diagram-row", { has: page.locator(`summary[aria-label="Actions for ${name}"]`) });
    const settle = () => page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saved");
    await page.goto(`http://127.0.0.1:${app.server.port}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "UML", exact: true }).click();
    await page.getByRole("button", { name: "Add UML to this project", exact: true }).click();
    await page.getByRole("region", { name: "UML editor", exact: true }).waitFor();

    // U03: every shape from the + Shape menu.
    for (const shape of shapeSchema.options) {
      await page.getByText("+ Shape", { exact: true }).click();
      await page.getByRole("button", { name: `Add ${shape}`, exact: true }).click();
    }
    await settle();
    expect((await saved()).diagrams[0]?.nodes.map(n => n.shape)).toEqual([...shapeSchema.options]);
    for (const shape of shapeSchema.options) expect(await page.locator(`.uml-node--${shape}`).count()).toBe(1);

    // U02: new, rename, duplicate and delete, with a confirmation for delete.
    await page.getByRole("textbox", { name: "New diagram name", exact: true }).fill("Data flow");
    await page.getByRole("button", { name: "New diagram", exact: true }).click();
    await page.locator(".uml-canvas-header strong", { hasText: "Data flow" }).waitFor();
    expect((await saved()).diagrams.map(d => d.name)).toEqual(["System overview", "Data flow"]);

    answers.push("Request flow");
    await page.locator(`summary[aria-label="Actions for Data flow"]`).click();
    await row("Data flow").getByRole("button", { name: "Rename", exact: true }).click();
    await page.locator(".uml-canvas-header strong", { hasText: "Request flow" }).waitFor();
    expect((await saved()).diagrams.map(d => d.name)).toEqual(["System overview", "Request flow"]);

    await page.locator(`summary[aria-label="Actions for System overview"]`).click();
    await row("System overview").getByRole("button", { name: "Duplicate", exact: true }).click();
    await page.locator(".uml-canvas-header strong", { hasText: "System overview copy" }).waitFor();
    const copies = (await saved()).diagrams;
    expect(copies.map(d => d.name)).toEqual(["System overview", "Request flow", "System overview copy"]);
    expect(copies[2]?.nodes).toHaveLength(shapeSchema.options.length);
    expect(copies[2]?.id).not.toBe(copies[0]?.id);

    answers.push(false);
    await page.locator(`summary[aria-label="Actions for Request flow"]`).click();
    await row("Request flow").getByRole("button", { name: "Delete", exact: true }).click();
    expect(dialogs.at(-1)).toBe('Delete "Request flow"? This removes its boxes, arrows and comments.');
    expect((await saved()).diagrams).toHaveLength(3);
    // An action closes its menu.
    expect(await page.locator(".uml-diagram-row details[open]").count()).toBe(0);
    answers.push(true);
    await page.locator(`summary[aria-label="Actions for Request flow"]`).click();
    await row("Request flow").getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll(".uml-diagram-choice")].some(b => b.textContent?.startsWith("Request flow")));
    expect((await saved()).diagrams.map(d => d.name)).toEqual(["System overview", "System overview copy"]);
    expect(errors).toEqual([]);
  } finally { await browser.close(); app.stop(); await rm(workspace, { recursive: true, force: true }); }
}, 60_000);
