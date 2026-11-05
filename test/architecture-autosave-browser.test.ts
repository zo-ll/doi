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

async function withEditor(run: (page: import("playwright-core").Page, workspace: string, dialogs: string[]) => Promise<void>) {
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
    await run(page, workspace, dialogs);
    expect(errors).toEqual([]);
  } finally { await browser.close(); app.stop(); await rm(workspace, { recursive: true, force: true }); }
}
const storedName = async (workspace: string) => (await readArchitecture(workspace, "sample")).state.diagrams[0]?.nodes[0]?.name;
const savedState = (page: import("playwright-core").Page) => page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saved");

test.skipIf(!hasBrowser)("an edit made while Back saves is saved too", async () => {
  await withEditor(async (page, workspace, dialogs) => {
    const gate = Promise.withResolvers<void>();
    let puts = 0;
    await page.route("**/api/projects/sample/architecture", async route => { if (route.request().method() === "PUT" && ++puts === 1) await gate.promise; await route.continue(); });
    try {
      const name = page.getByRole("textbox", { name: "Box name", exact: true });
      await name.fill("First edit");
      await page.getByRole("button", { name: "← Back to UI design", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Saving…");
      await name.fill("Edit during Back");
      gate.resolve();
      await page.getByRole("region", { name: "UML editor", exact: true }).waitFor({ state: "detached" });
      expect(await storedName(workspace)).toBe("Edit during Back");
      expect(dialogs).toEqual([]);
    } finally { gate.resolve(); }
  });
}, 30_000);

test.skipIf(!hasBrowser)("a restore waits for the version of the current state, even when that record is slow", async () => {
  await withEditor(async (page, workspace) => {
    const name = page.getByRole("textbox", { name: "Box name", exact: true });
    const fileAt = async (sha: string) => JSON.parse(await $`git show ${sha}:projects/sample/architecture.json`.cwd(workspace).text()).diagrams[0].nodes[0].name;
    const log = async () => (await $`git log --format=%H -- projects/sample/architecture.json`.cwd(workspace).nothrow().quiet().text()).split("\n").filter(Boolean);
    await name.fill("Version one");
    await savedState(page);
    await page.getByRole("button", { name: "Save diagram", exact: true }).click();
    await page.getByText("Saved. doi recorded this version.").waitFor();
    await name.fill("Saved two");
    await savedState(page);
    await page.route("**/api/projects/sample/architecture/checkpoint", async route => { await Bun.sleep(1500); await route.continue(); });
    await page.getByRole("tab", { name: "History", exact: true }).click();
    await page.getByRole("list", { name: "Saved versions", exact: true }).getByRole("button").first().click();
    await page.getByText("Restored the saved version. Undo reverses it.").waitFor();
    await savedState(page);
    const shas = await log();
    expect(shas).toHaveLength(2);
    expect(await fileAt(shas[0] ?? "")).toBe("Saved two");
    expect(await storedName(workspace)).toBe("Version one");
    await page.keyboard.press("Control+s");
    await page.getByText("Saved. doi recorded this version.").waitFor();
    await page.keyboard.press("Control+s");
    await page.getByText("Saved. No change to record.").waitFor();
  });
}, 30_000);

test.skipIf(!hasBrowser)("a fixed value starts autosave again", async () => {
  await withEditor(async (page, workspace) => {
    const name = page.getByRole("textbox", { name: "Box name", exact: true });
    await name.fill("");
    await page.waitForFunction(() => document.querySelector(".uml-save-state")?.textContent === "Not saved");
    await name.fill("Fixed");
    await savedState(page);
    expect(await storedName(workspace)).toBe("Fixed");
  });
}, 30_000);

test.skipIf(!hasBrowser)("a version that git refuses is never reported as no change", async () => {
  await withEditor(async (page, workspace) => {
    await Bun.write(join(workspace, ".gitignore"), "projects/sample/architecture.json\n");
    const name = page.getByRole("textbox", { name: "Box name", exact: true });
    await name.fill("One");
    await savedState(page);
    await page.keyboard.press("Control+s");
    await page.getByText("doi could not record a version: the workspace history (git) did not accept the UML file. Saves still work.").waitFor();
    await name.fill("Two");
    await savedState(page);
    await page.keyboard.press("Control+s");
    await page.getByText("Saved. The version was not recorded.").waitFor();
    expect(await storedName(workspace)).toBe("Two");
  });
}, 30_000);
