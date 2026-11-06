import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { parseConfig } from "../src/config.ts";
import { startServer } from "../src/server/app.ts";

const hasBrowser = await chromium.launch().then(
  (browser) => browser.close().then(() => true),
  () => false,
);
test.if(!!process.env.CI)("CI has Chromium for the mobile app checks", () => expect(hasBrowser).toBe(true));

const HOME = "/api/projects/sample/designs/home";

/** The sample design as a mobile app, open in a browser. */
async function driveApp(prepare: (workspace: string) => Promise<void>, run: (d: { page: Page; context: BrowserContext; origin: string; workspace: string }) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "doi-app-kind-browser-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  const browser = await chromium.launch();
  try {
    const origin = `http://127.0.0.1:${app.server.port}`;
    const kind = await fetch(`${origin}${HOME}/kind`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: true }) });
    expect(kind.ok).toBe(true);
    await prepare(workspace);
    const context = await browser.newContext();
    await context.route("**/api/providers", (route) => route.fulfill({ json: [] }));
    const page = await context.newPage();
    await page.goto(`${origin}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await run({ page, context, origin, workspace });
  } finally {
    await browser.close();
    app.stop();
    await rm(workspace, { recursive: true, force: true });
  }
}

test.skipIf(!hasBrowser)("F adds a screen, but not during a version preview", async () => {
  await driveApp(async () => {}, async ({ page, context, workspace }) => {
    const at = new Date().toISOString();
    await context.route(`**${HOME}/history`, (route) =>
      route.fulfill({
        json: [
          { sha: "a".repeat(40), at, message: "Newest version" },
          { sha: "b".repeat(40), at, message: "Older version" },
        ],
      }),
    );
    await context.route(`**${HOME}/pages?sha=*`, (route) => route.fulfill({ json: ["index.html"] }));
    let adds = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith(`${HOME}/screens`)) adds++;
    });
    const pressF = async () => {
      // An empty composer takes the focus on load, and F is plain text there.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("f");
    };
    await page.getByRole("button", { name: "+ Screen" }).waitFor();

    await page.getByRole("tab", { name: "History" }).click();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.locator(".preview-banner").waitFor();
    await pressF();
    await Bun.sleep(300);
    expect(adds).toBe(0);
    expect(await Bun.file(join(workspace, "projects/sample/designs/home/screen-2.html")).exists()).toBe(false);

    // The guard stops only the preview: without it, the same key adds the screen.
    await page.getByRole("button", { name: "Close preview" }).click();
    await page.locator(".preview-banner").waitFor({ state: "detached" });
    await pressF();
    await page.waitForFunction(() => location.search.includes("page=screen-2.html"));
    expect(adds).toBe(1);
  });
}, 30_000);

test.skipIf(!hasBrowser)("a design that is both an app and a deck can go back to a web page", async () => {
  await driveApp(
    (workspace) => Bun.write(join(workspace, "projects/sample/designs/home/index.html"), '<!doctype html><section data-slide data-oid="s1">Slide</section>').then(() => {}),
    async ({ page, origin }) => {
      const toggle = page.getByRole("button", { name: "Mobile app" });
      await toggle.waitFor();
      expect(await toggle.getAttribute("aria-pressed")).toBe("true");
      await toggle.click();
      // A plain deck cannot be an app: the toggle goes away after the change.
      await toggle.waitFor({ state: "detached" });
      const projects = (await (await fetch(`${origin}/api/projects`)).json()) as { id: string; apps: string[]; decks: string[] }[];
      const sample = projects.find((p) => p.id === "sample");
      expect(sample?.apps).toEqual([]);
      expect(sample?.decks).toEqual(["home"]);
    },
  );
}, 30_000);
