import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { parseConfig } from "../src/config.ts";
import { startServer } from "../src/server/app.ts";

const hasBrowser = await chromium.launch().then(
  (browser) => browser.close().then(() => true),
  () => false,
);
test.if(!!process.env.CI)("CI has Chromium for the projects drawer", () => expect(hasBrowser).toBe(true));

test.skipIf(!hasBrowser)("a design has an explicit rename control without a navigation delay", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "doi-projects-browser-"));
  let browser: Browser | undefined;
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.route("**/api/providers", (route) => route.fulfill({ json: [] }));
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${app.server.port}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Projects and designs" }).click();
    const rename = page.getByRole("button", { name: "Rename design home in Sample", exact: true });
    await rename.waitFor({ timeout: 2500 });
    await rename.click();
    const field = page.getByLabel("New name for design home", { exact: true });
    await field.fill("renamed");
    await field.press("Enter");
    await page.waitForURL("**design=renamed");
    expect(await Bun.file(join(workspace, "projects/sample/designs/renamed/index.html")).exists()).toBe(true);
    expect(await Bun.file(join(workspace, "projects/sample/designs/home/index.html")).exists()).toBe(false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Projects and designs" }).click();
    const design = page.locator("button.nav-design").filter({ hasText: "renamed" });
    await design.click();
    await page.locator(".nav-drawer").waitFor({ state: "hidden", timeout: 1000 });
    await page.getByRole("button", { name: "Projects and designs" }).click();
    await design.focus();
    await design.press("F2");
    await page.getByLabel("New name for design renamed", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    expect(await page.locator(".nav-drawer").isVisible()).toBe(true);
    expect(await page.getByLabel("New name for design renamed", { exact: true }).count()).toBe(0);
  } finally {
    await browser?.close();
    app?.stop();
    await rm(workspace, { recursive: true, force: true });
  }
}, 15_000);
