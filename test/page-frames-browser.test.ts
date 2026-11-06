import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { parseConfig } from "../src/config.ts";
import { startServer } from "../src/server/app.ts";

const hasBrowser = await chromium.launch().then(
  (browser) => browser.close().then(() => true),
  () => false,
);
test.if(!!process.env.CI)("CI has Chromium for the page frame checks", () => expect(hasBrowser).toBe(true));

const HOME = "/api/projects/sample/designs/home";

async function drive(pages: string[], run: (d: { page: Page; origin: string; workspace: string }) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "doi-page-frames-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  const browser = await chromium.launch();
  try {
    const dir = join(workspace, "projects/sample/designs/home");
    const head = await Bun.file(join(dir, "index.html")).text();
    for (const name of pages) await Bun.write(join(dir, name), head);
    const context = await browser.newContext();
    await context.route("**/api/providers", (route) => route.fulfill({ json: [] }));
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${app.server.port}`;
    await page.goto(`${origin}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await run({ page, origin, workspace });
  } finally {
    await browser.close();
    app.stop();
    await rm(workspace, { recursive: true, force: true });
  }
}

const labels = (page: Page) => page.locator(".frame-name").allTextContents();

test.skipIf(!hasBrowser)("a design with one page keeps its Desktop and Mobile frames", async () => {
  await drive([], async ({ page }) => {
    await page.locator(".frame-name").first().waitFor();
    expect(await labels(page)).toEqual(["Desktop", "Mobile"]);
  });
}, 30_000);

test.skipIf(!hasBrowser)("a design with several pages shows one frame per page; a move and an added frame stay", async () => {
  await drive(["02-signup.html", "03-dashboard.html"], async ({ page, origin }) => {
    const names = ["index", "02-signup", "03-dashboard"];
    await page.locator(".frame-name").nth(2).waitFor();
    expect(await labels(page)).toEqual(names);
    expect(await page.locator(".frame-size").first().textContent()).toContain("1440");
    expect(await page.locator("figure.frame iframe").evaluateAll((els) => els.map((e) => (e as HTMLIFrameElement).getAttribute("src")?.includes("03-dashboard")))).toEqual([false, false, true]);

    // A move: drag a frame label.
    const before = await page.locator("figure.frame").nth(1).evaluate((e) => (e as HTMLElement).style.left);
    const label = await page.locator(".frame-label").nth(1).boundingBox();
    await page.mouse.move(label!.x + 5, label!.y + 5);
    await page.mouse.down();
    await page.mouse.move(label!.x + 5, label!.y + 105, { steps: 4 });
    await page.mouse.up();
    await page.waitForResponse((r) => r.url().endsWith(`${HOME}/layout`) && r.request().method() === "PUT").catch(() => {});

    // An added frame shows the open page at its own size.
    await page.getByRole("button", { name: /\+ Frame/ }).click();
    await page.locator(".menu").getByText("Mobile", { exact: false }).first().click();
    await page.locator(".frame-name").nth(3).waitFor();
    expect(await labels(page)).toEqual([...names, "Mobile"]);

    await Bun.sleep(200);
    const stored = (await (await fetch(`${origin}${HOME}/layout`)).json()) as { id: string; page?: string; y: number; x: number }[];
    expect(stored.map((f) => f.page)).toEqual(["index.html", "02-signup.html", "03-dashboard.html", undefined]);
    expect(stored[1]!.y).toBeGreaterThan(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".frame-name").nth(3).waitFor();
    expect(await labels(page)).toEqual([...names, "Mobile"]);
    expect(await page.locator("figure.frame").nth(1).evaluate((e) => (e as HTMLElement).style.top)).not.toBe("0px");
    expect(before).toBeTruthy();

    // Export sees the real sizes: Desktop and Mobile, not four frames.
    await page.getByRole("button", { name: "Export" }).click();
    const dialog = page.getByRole("dialog", { name: /Export/ });
    await dialog.getByRole("radio", { name: /PNG/ }).click();
    const sizes = await dialog.getByRole("radiogroup", { name: "Frames" }).getByRole("radio").allTextContents();
    expect(sizes.some((s) => s.includes("Desktop"))).toBe(true);
    expect(sizes.some((s) => s.includes("Mobile"))).toBe(true);
    expect(sizes.some((s) => s.includes("dashboard") || s.includes("signup"))).toBe(false);
  });
}, 30_000);

test.skipIf(!hasBrowser)("a click in a page frame opens that page", async () => {
  await drive(["02-signup.html"], async ({ page }) => {
    await page.locator(".frame-name").nth(1).waitFor();
    await page.locator(".frame-label").nth(1).waitFor();
    const target = page.locator("figure.frame iframe").nth(1).contentFrame().locator("[data-oid]").first();
    await target.waitFor();
    // Inside a scaled frame, only a click at page coordinates reaches the page.
    const box = await target.boundingBox();
    await page.mouse.click(box!.x + 5, box!.y + 5);
    await page.waitForFunction(() => location.search.includes("page=02-signup.html"));
  });
}, 30_000);

test.skipIf(!hasBrowser)("a deck stays one frame, also with a second page", async () => {
  await drive(["notes.html"], async ({ page, workspace, origin }) => {
    await Bun.write(join(workspace, "projects/sample/designs/home/index.html"), '<!doctype html><section data-slide data-oid="s1">Slide</section>');
    await page.goto(`${origin}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await page.locator(".frame-name").first().waitFor();
    await Bun.sleep(300);
    expect(await labels(page)).toEqual(["Desktop", "Mobile"]);
  });
}, 30_000);

test.skipIf(!hasBrowser)("a mobile app keeps its phone frames", async () => {
  await drive(["files.html"], async ({ page, origin }) => {
    const kind = await fetch(`${origin}${HOME}/kind`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: true }) });
    expect(kind.ok).toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".frame-name").nth(1).waitFor();
    expect(await labels(page)).toEqual(["index", "files"]);
    expect(await page.locator(".frame-size").first().textContent()).toContain("390");
  });
}, 30_000);
