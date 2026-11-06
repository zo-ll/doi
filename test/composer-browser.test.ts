import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { parseConfig } from "../src/config.ts";
import { startServer } from "../src/server/app.ts";

const hasBrowser = await chromium.launch().then(
  (browser) => browser.close().then(() => true),
  () => false,
);
test.if(!!process.env.CI)("CI has Chromium for the composer checks", () => expect(hasBrowser).toBe(true));

const HOME = "/api/projects/sample/designs/home";

test.skipIf(!hasBrowser)("the composer has no variants selector, and a send starts one turn", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "doi-composer-browser-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  const browser = await chromium.launch();
  try {
    const origin = `http://127.0.0.1:${app.server.port}`;
    const context = await browser.newContext();
    await context.route("**/api/providers", (route) => route.fulfill({ json: [] }));
    let turns = 0;
    await context.route(`**${HOME}/turns`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      turns++;
      await route.abort();
    });
    const page = await context.newPage();
    const asked: string[] = [];
    page.on("request", (r) => asked.push(r.url()));
    await page.goto(`${origin}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    const composer = page.locator(".chat textarea");
    await composer.waitFor();

    expect(await page.getByRole("radiogroup", { name: "Variants" }).count()).toBe(0);
    expect(await page.locator(".composer .seg").count()).toBe(0);

    await composer.fill("Change the title");
    expect(await page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
    await composer.press("Control+Enter");
    await page.waitForFunction(() => document.querySelector(".chat .msg-user, .chat [class*='user']") !== null);
    await Bun.sleep(300);
    expect(turns).toBe(1);
    expect(asked.filter((url) => /\/variants?(\/|$)/.test(new URL(url).pathname))).toEqual([]);

    // The routes went with the feature.
    expect((await fetch(`${origin}${HOME}/variants`)).status).toBe(404);
    expect((await fetch(`${origin}/variant/sample/home/s1/1/`)).status).toBe(404);
  } finally {
    await browser.close();
    app.stop();
    await rm(workspace, { recursive: true, force: true });
  }
}, 30_000);
