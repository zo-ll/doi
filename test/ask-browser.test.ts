import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { parseConfig } from "../src/config.ts";
import { startServer } from "../src/server/app.ts";
import { appendChat, type ChatEntry } from "../src/workspace/chat.ts";

const hasBrowser = await chromium.launch().then(
  (browser) => browser.close().then(() => true),
  () => false,
);
test.if(!!process.env.CI)("CI has Chromium for the ask card checks", () => expect(hasBrowser).toBe(true));

const HOME = "/api/projects/sample/designs/home";
const at = "2026-11-06T00:00:00.000Z";
const BLOCK = '```ask\n{"questions":[{"question":"What must the app do?","options":["Track tasks","Sell products"]},{"question":"How much first?","options":["One screen","The full flow"]}]}\n```';
const sse = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

async function drive(prepare: (workspace: string) => Promise<void>, run: (d: { page: Page; context: BrowserContext; origin: string; bodies: { text: string; target?: string | null }[]; answers: string[] }) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "doi-ask-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  const browser = await chromium.launch();
  try {
    await prepare(workspace);
    const context = await browser.newContext();
    await context.route("**/api/providers", (route) => route.fulfill({ json: [] }));
    const bodies: { text: string }[] = [];
    const answers = [`I need two answers.\n\n${BLOCK}`, "I made one screen."];
    await context.route(`**${HOME}/turns`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      bodies.push(route.request().postDataJSON() as { text: string });
      const text = answers.shift() ?? "Done.";
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse([{ type: "text", delta: text }, { type: "done" }]) });
    });
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${app.server.port}`;
    await page.goto(`${origin}/?project=sample&design=home`, { waitUntil: "domcontentloaded" });
    await run({ page, context, origin, bodies, answers });
  } finally {
    await browser.close();
    app.stop();
    await rm(workspace, { recursive: true, force: true });
  }
}

const card = (page: Page) => page.getByRole("group", { name: "Questions from the model" });

async function ask(page: Page) {
  const composer = page.locator(".chat textarea");
  await composer.fill("Make me an app");
  await composer.press("Control+Enter");
  await card(page).waitFor();
}

test.skipIf(!hasBrowser)("an ask block shows as a card; the answer goes as the next message", async () => {
  await drive(async () => {}, async ({ page, bodies }) => {
    await ask(page);
    expect(await page.locator(".turn-ai .msg-text").first().textContent()).toBe("I need two answers.");
    expect(await page.locator(".chat").textContent()).not.toContain('"questions"');
    const send = card(page).getByRole("button", { name: "Send answer" });
    expect(await send.isDisabled()).toBe(true);

    await card(page).getByRole("button", { name: "Track tasks" }).click();
    expect(await card(page).getByRole("button", { name: "Track tasks" }).getAttribute("aria-pressed")).toBe("true");
    await card(page).getByLabel("Your answer: How much first?").fill("Sign in and the list");
    await send.click();

    await page.getByText("I made one screen.").waitFor();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.text).toBe("What must the app do?\nTrack tasks\n\nHow much first?\nSign in and the list");
    // A later message answered the card: it stays as a record, without controls.
    expect(await card(page).getByRole("button").count()).toBe(0);
    expect(await card(page).textContent()).toContain("What must the app do?");
  });
}, 30_000);

test.skipIf(!hasBrowser)("You choose leaves every choice to the model", async () => {
  await drive(async () => {}, async ({ page, bodies }) => {
    await ask(page);
    await card(page).getByRole("button", { name: "You choose" }).click();
    await page.getByText("I made one screen.").waitFor();
    expect(bodies[1]!.text).toBe("What must the app do?\nYou choose.\n\nHow much first?\nYou choose.");
  });
}, 30_000);

test.skipIf(!hasBrowser)("a stored ask block still shows as a card after a reload, and a broken one as text", async () => {
  const usage = { inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
  const entry = (turn: string, role: "user" | "assistant", text: string): ChatEntry =>
    role === "user"
      ? { role, turn, design: "home", at, text, target: null }
      : { role, turn, design: "home", at, text, status: "done", provider: "anthropic", model: "m", usage, files: [], prompt: "v3" };
  await drive(
    async (workspace) => {
      await appendChat(workspace, "sample", entry("t1", "user", "First"));
      await appendChat(workspace, "sample", entry("t1", "assistant", "```ask\nnot json\n```"));
      await appendChat(workspace, "sample", entry("t2", "user", "Second"));
      await appendChat(workspace, "sample", entry("t2", "assistant", BLOCK));
    },
    async ({ page, bodies }) => {
      await card(page).waitFor();
      expect(await page.locator(".chat").textContent()).toContain("not json");
      expect(await card(page).count()).toBe(1);
      await card(page).getByRole("button", { name: "One screen" }).click();
      await card(page).getByRole("button", { name: "Send answer" }).click();
      await page.getByText("I need two answers.").waitFor();
      expect(bodies[0]!.text).toContain("How much first?\nOne screen");
    },
  );
}, 30_000);
