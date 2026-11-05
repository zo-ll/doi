import { expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { parseConfig } from "../src/config.ts";
import { startServer } from "../src/server/app.ts";
import { createDiagram } from "../src/architecture/schema.ts";
import { createNode } from "../src/architecture/nodes.ts";
import { readArchitecture, writeArchitecture } from "../src/workspace/architecture.ts";

const hasBrowser = await chromium.launch().then(browser => browser.close().then(() => true), () => false);
test.if(!!process.env.CI)("CI has Chromium for the UML autosave cases", () => expect(hasBrowser).toBe(true));

test.skipIf(!hasBrowser)("autosave stores edits; Save, versions, restore, undo and Back record history", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "doi-uml-autosave-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  const browser = await chromium.launch();
  try {
    await writeArchitecture(workspace, "sample", null, { version: 1, enabled: true, diagrams: [{ ...createDiagram(), nodes: [createNode("box", { x: 80, y: 80 }, "Start")] }] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route("**/api/providers", route => route.fulfill({ json: [] }));
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    const dialogs: string[] = []; page.on("dialog", dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await page.goto(`http://127.0.0.1:${app.server.port}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "UML", exact: true }).click();
    await page.getByRole("button", { name: /System overview/ }).click();
    await page.getByRole("group", { name: "Start", exact: true }).click();
    const name = page.getByRole("textbox", { name: "Box name", exact: true });
    const stored = async () => (await readArchitecture(workspace, "sample")).state.diagrams[0]?.nodes[0]?.name;
    const state = () => page.locator(".uml-save-state").innerText();
    const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 50; i++) { if (await check()) return; await Bun.sleep(100); } throw new Error("Timed out"); };
    const versions = async () => (await $`git log --format=%s -- projects/sample/architecture.json`.cwd(workspace).nothrow().quiet().text()).split("\n").filter(Boolean);

    // Autosave: no click.
    await name.fill("Autosaved");
    await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saved");
    expect(await stored()).toBe("Autosaved");
    expect(await versions()).toEqual([]);

    // Save records a version.
    await page.getByRole("button", { name: "Save diagram", exact: true }).click();
    await page.getByText("Saved. doi recorded this version.").waitFor();
    await until(async () => (await versions()).length === 1);
    expect(await versions()).toEqual(["UML: System overview"]);

    await name.fill("Second");
    await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saved");
    await page.keyboard.press("Control+s");
    await until(async () => (await versions()).length === 2);

    // Restore the first version: an undoable edit that autosave stores.
    await page.getByRole("tab", { name: "History", exact: true }).click();
    const list = page.getByRole("list", { name: "Saved versions", exact: true });
    await list.getByRole("listitem").nth(1).waitFor();
    await list.getByRole("listitem").nth(1).getByRole("button").click();
    await page.getByText("Restored the saved version. Undo reverses it.").waitFor();
    // The state before the restore ("Second", saved by Ctrl+S) is already a version: no extra commit.
    expect((await versions()).length).toBe(2);
    await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saved");
    expect(await stored()).toBe("Autosaved");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Unsaved changes" || document.querySelector(".uml-save-state")?.textContent === "Saving…");
    await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saved");
    expect(await stored()).toBe("Second");

    // Back records the autosaved edits as a version, without a discard question.
    await page.getByRole("tab", { name: "UML", exact: true }).click();
    await page.getByRole("group", { name: "Second", exact: true }).click();
    await name.fill("Before leave");
    await page.getByRole("button", { name: "← Back to UI design", exact: true }).click();
    await page.getByRole("region", { name: "UML editor", exact: true }).waitFor({ state: "detached" });
    expect(await stored()).toBe("Before leave");
    await until(async () => (await versions()).length === 3);
    expect(dialogs).toEqual([]);
    expect(await state().catch(() => "gone")).toBe("gone");
    expect(errors).toEqual([]);
  } finally { await browser.close(); app.stop(); await rm(workspace, { recursive: true, force: true }); }
}, 45_000);
