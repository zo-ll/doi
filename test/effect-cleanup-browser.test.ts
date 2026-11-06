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
test.if(!!process.env.CI)("CI has Chromium for the effect cleanup checks", () => expect(hasBrowser).toBe(true));

const OLD_COMMENT = "Comment of the first design";
const DESIGNS = "/api/projects/sample/designs";

type Drive = { page: Page; context: BrowserContext; origin: string; workspace: string; oid: string };

/** The sample workspace in a browser, with a second design and an open comment on the first one. */
async function drive(run: (d: Drive) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "doi-effects-browser-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  const browser = await chromium.launch();
  try {
    const origin = `http://127.0.0.1:${app.server.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post(DESIGNS, { id: "other" })).ok).toBe(true);
    const html = await Bun.file(join(workspace, "projects/sample/designs/home/index.html")).text();
    const oid = /data-oid="([^"]+)"/.exec(html)![1]!;
    expect((await post(`${DESIGNS}/home/comments`, { oid, text: OLD_COMMENT })).ok).toBe(true);
    const context = await browser.newContext();
    await context.route("**/api/providers", (route) => route.fulfill({ json: [] }));
    await run({ page: await context.newPage(), context, origin, workspace, oid });
  } finally {
    await browser.close();
    app.stop();
    await rm(workspace, { recursive: true, force: true });
  }
}

/**
 * Records, after each DOM change, every commit that names the new design and still shows a
 * marker of the old one. A MutationObserver runs before the next paint and before a passive
 * effect's update, so it sees the frame that a reset in an effect leaves behind.
 */
async function watchStaleFrames(page: Page, markers: { text?: string; selector?: string }[]) {
  await page.evaluate((list) => {
    const seen: string[] = [];
    (window as unknown as { staleFrames: string[] }).staleFrames = seen;
    new MutationObserver(() => {
      if (!document.querySelector(".crumb-current")?.textContent?.includes("other")) return;
      for (const m of list) {
        if (m.text && document.body.textContent?.includes(m.text)) seen.push(m.text);
        if (m.selector && document.querySelector(m.selector)) seen.push(m.selector);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  }, markers);
}
const staleFrames = (page: Page) => page.evaluate(() => (window as unknown as { staleFrames: string[] }).staleFrames);

async function openOther(page: Page) {
  await page.getByRole("button", { name: "Projects and designs" }).click();
  await page.locator("button.nav-design").filter({ hasText: "other" }).click();
  await page.locator(".crumb-current").filter({ hasText: "other" }).waitFor();
}

test.skipIf(!hasBrowser)("a design switch shows no comments or variants of the old design", async () => {
  await drive(async ({ page, context, origin }) => {
    await context.route(`**${DESIGNS}/home/variants`, (route) =>
      route.fulfill({ json: { id: "set-1", prompt: "Old variants", target: null, createdAt: new Date().toISOString(), promptVersion: "v0", variants: [] } }),
    );
    // A slow answer for the new design, so the old data has time to show.
    await context.route(`**${DESIGNS}/other/comments`, async (route) => {
      await Bun.sleep(300);
      await route.continue();
    });
    await page.goto(`${origin}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await page.getByText(OLD_COMMENT).waitFor();
    await page.locator(".variants-view").waitFor();
    await watchStaleFrames(page, [{ text: OLD_COMMENT }, { selector: ".variants-view" }]);
    await openOther(page);
    await page.locator(".comments-bar .panel-meta").filter({ hasText: "0 open" }).waitFor();
    expect(await staleFrames(page)).toEqual([]);
  });
}, 30_000);

test.skipIf(!hasBrowser)("a design switch shows no version list or preview of the old design", async () => {
  await drive(async ({ page, context, origin }) => {
    const at = new Date().toISOString();
    await context.route(`**${DESIGNS}/home/history`, (route) =>
      route.fulfill({
        json: [
          { sha: "a".repeat(40), at, message: "Old newest version" },
          { sha: "b".repeat(40), at, message: "Old older version" },
        ],
      }),
    );
    await page.goto(`${origin}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "History" }).click();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.locator(".preview-banner").waitFor();
    await watchStaleFrames(page, [{ text: "Old newest version" }, { selector: ".preview-banner" }]);
    await openOther(page);
    await page.locator(".preview-banner").waitFor({ state: "detached" });
    expect(await staleFrames(page)).toEqual([]);
  });
}, 30_000);

test.skipIf(!hasBrowser)("N opens a focused comment form once, and it stays closed after a tab change", async () => {
  await drive(async ({ page, origin, oid }) => {
    await page.goto(`${origin}/?project=sample&design=home&node=${oid}`, { waitUntil: "domcontentloaded" });
    await page.getByText(OLD_COMMENT).waitFor();
    await page.locator(".node-link").waitFor();
    // An empty composer takes the focus on load, and N is plain text there.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("n");
    const form = page.getByLabel("Comment", { exact: true });
    await form.waitFor();
    expect(await form.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await form.inputValue()).toBe("");
    await page.locator(".comment-new").getByRole("button", { name: "Cancel" }).click();
    await form.waitFor({ state: "detached" });
    await page.getByRole("tab", { name: "History" }).click();
    await page.getByRole("tab", { name: "Comments" }).click();
    await page.getByText(OLD_COMMENT).waitFor();
    expect(await form.count()).toBe(0);
  });
}, 30_000);

test.skipIf(!hasBrowser)("a comment that closes leaves the next turn and stays out when it opens again", async () => {
  await drive(async ({ page, origin }) => {
    await page.goto(`${origin}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    const chip = page.locator(".chip-comment");
    await chip.waitFor();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await chip.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Reopen" }).click();
    await page.getByRole("button", { name: "Apply", exact: true }).waitFor();
    expect(await chip.count()).toBe(0);
  });
}, 30_000);

test.skipIf(!hasBrowser)("a missing page falls back to the first page; a new screen stays open before the list has it", async () => {
  await drive(async ({ page, context, origin }) => {
    await page.goto(`${origin}/?project=sample&design=home&page=gone.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => new URLSearchParams(location.search).get("design") === "home" && !location.search.includes("gone.html"));
    // The list that follows "+ Screen" comes late: the new page must stay in that time.
    expect((await fetch(`${origin}${DESIGNS}/home/kind`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: true }) })).ok).toBe(true);
    await page.goto(`${origin}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    const add = page.getByRole("button", { name: "+ Screen" });
    await add.waitFor();
    await context.route(`**${DESIGNS}/home/pages?r=*`, async (route) => {
      await Bun.sleep(400);
      await route.continue();
    });
    await add.click();
    await page.waitForFunction(() => location.search.includes("page=screen-2.html"));
    await Bun.sleep(1000);
    expect(page.url()).toContain("page=screen-2.html");
  });
}, 30_000);

test.skipIf(!hasBrowser)("the chat's running state reaches the top bar and ends when the design changes", async () => {
  await drive(async ({ page, context, origin }) => {
    const held = Promise.withResolvers<void>();
    await context.route(`**${DESIGNS}/home/turns`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await held.promise;
      await route.abort().catch(() => {});
    });
    await page.goto(`${origin}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    const composer = page.locator(".chat textarea");
    await composer.fill("Change the title");
    await composer.press("Control+Enter");
    const working = page.getByText("working…");
    await working.waitFor();
    await openOther(page);
    await working.waitFor({ state: "detached" });
    held.resolve();
  });
}, 30_000);

test.skipIf(!hasBrowser)("the handoff zip tab loads its draft once and keeps the user's text", async () => {
  await drive(async ({ page, context, origin }) => {
    let drafts = 0;
    await context.route(`**${DESIGNS}/home/handoff`, async (route) => {
      if (route.request().method() === "GET") drafts++;
      await route.continue();
    });
    await page.goto(`${origin}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Hand off" }).click();
    const dialog = page.getByRole("dialog", { name: "Hand off" });
    await dialog.waitFor();
    expect(drafts).toBe(0);
    const tabs = dialog.getByRole("tab");
    await tabs.nth(1).click();
    const markdown = dialog.getByLabel("HANDOFF.md");
    await markdown.waitFor();
    await markdown.fill("My own text");
    await tabs.nth(0).click();
    await tabs.nth(1).click();
    expect(await markdown.inputValue()).toBe("My own text");
    expect(drafts).toBe(1);
  });
}, 30_000);

test.skipIf(!hasBrowser)("a login shows its result when the CLI reports it", async () => {
  await drive(async ({ page, context, origin }) => {
    let ready = false;
    await context.unroute("**/api/providers");
    await context.route("**/api/providers", (route) =>
      route.fulfill({ json: [{ id: "claude-code", source: "cli", ready, detail: "", implemented: true }] }),
    );
    await context.route("**/api/providers/claude-code/login", (route) => route.fulfill({ json: { url: "https://example.com/login" } }));
    await page.goto(`${origin}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("radio", { name: /OAuth|subscription/i }).click().catch(() => {});
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByRole("button", { name: "Waiting for the login…" }).waitFor();
    ready = true;
    await page.locator("p.status").filter({ hasText: "Logged in." }).waitFor({ timeout: 10_000 });
    expect(await page.getByRole("button", { name: "Waiting for the login…" }).count()).toBe(0);
  });
}, 30_000);
