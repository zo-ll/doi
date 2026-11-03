import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { loadConfig } from "../src/config.ts";
import { memoryKeyStore, setKeyStore } from "../src/providers/keys.ts";
import { startServer } from "../src/server/app.ts";

// This is a real-browser check of the first-use flow. Provider status and model catalogs are
// controlled API fixtures (`providers`, `catalog`), so a logged-out CLI or a network answer
// cannot make the result differ. A configured fixture is marked in the test that uses it.
// The save route is real, except in the save-error test, which intercepts it as a fixture.

const SHOTS = process.env.DOI_FIRST_USE_SHOTS ?? "/tmp/doi-first-use-browser-check";
const hasBrowser = await chromium.launch().then(
  (b) => b.close().then(() => true),
  () => false,
);
test.if(!!process.env.CI)("CI has Chromium for the first-use flow", () => {
  expect(hasBrowser).toBe(true);
});

let dir = "";
let workspace = "";
let configPath = "";
let app: Awaited<ReturnType<typeof startServer>>;
let origin = "";
let browser: Browser;

/** Fixture controls; each test resets them. */
let codexReady = true;
let opencodeReady = false;
let failProviders = false;
let failModels = false;
let failSave = false;
let failKey = false;
let failLogin = false;
/** A fixture gate: while set, GET /api/providers waits, so the flow shows its loading state. */
let providerGate: Promise<void> | null = null;
let releaseProviders: (() => void) | null = null;

const CLI = (id: "codex" | "claude-code", ready: boolean) => ({
  id,
  source: "cli",
  implemented: true,
  ready,
  detail: ready ? "Logged in" : "Not logged in",
});
const KEY = (id: "anthropic" | "openai" | "opencode-go", ready = false) => ({
  id,
  source: "api_key",
  implemented: true,
  ready,
  detail: ready ? "Key from OPENCODE_API_KEY" : "No API key. Add one, or set the variable",
  keyFrom: ready ? "env" : null,
  keyEnv: `${id.toUpperCase().replace("-", "_")}_API_KEY`,
});
const providerFixtures = () => [
  KEY("anthropic"),
  KEY("openai"),
  KEY("opencode-go", opencodeReady),
  { id: "google", source: "api_key", implemented: false, ready: false, detail: "No adapter" },
  { id: "openrouter", source: "api_key", implemented: false, ready: false, detail: "No adapter" },
  { id: "ollama", source: "local", implemented: false, ready: false, detail: "No server" },
  CLI("claude-code", true),
  CLI("codex", codexReady),
];

const CATALOG: Record<string, string[]> = {
  codex: ["gpt-6.1-sol", "gpt-6"],
  "claude-code": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  openai: ["gpt-6", "gpt-6-mini"],
  "opencode-go": ["deepseek-v4.1-flash"],
};

const BASELINE = () => `workspace = "${workspace}"
[models]
generate = "codex:gpt-6.1-sol"
edit = "codex:gpt-6.1-sol"
extract = "codex:gpt-6.1-sol"
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "doi-first-use-browser-"));
  workspace = join(dir, "workspace");
  configPath = join(dir, "config.toml");
  await Bun.write(configPath, BASELINE());
  app = await startServer(await loadConfig(configPath), { port: 0, development: false });
  origin = `http://127.0.0.1:${app.server.port}`;
  browser = await chromium.launch();
  await mkdir(SHOTS, { recursive: true });
});

afterAll(async () => {
  await browser?.close();
  app?.stop();
  // The key-save test stores a fixture key in the shared store (test/setup.ts). Clear it, so no
  // other test file sees a key that it did not set.
  setKeyStore(memoryKeyStore());
});

beforeEach(async () => {
  codexReady = true;
  opencodeReady = false;
  failProviders = false;
  failModels = false;
  failSave = false;
  failKey = false;
  failLogin = false;
  providerGate = null;
  releaseProviders = null;
  await Bun.write(configPath, BASELINE());
  await fetch(`${origin}/api/config/models`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generate: "codex:gpt-6.1-sol", edit: "codex:gpt-6.1-sol", extract: "codex:gpt-6.1-sol" }),
  });
});

/** A new browser context, with the provider, catalog and save routes controlled by the fixtures. */
async function open(
  path = "/",
  viewport = { width: 1440, height: 900 },
  colorScheme?: "light" | "dark",
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, ...(colorScheme ? { colorScheme } : {}) });
  await context.route("**/api/providers", async (route) => {
    if (providerGate) await providerGate;
    return failProviders ? route.fulfill({ status: 500, json: { error: "The provider status could not load: fixture." } }) : route.fulfill({ json: providerFixtures() });
  });
  await context.route("**/api/providers/*/login", (route) =>
    failLogin ? route.fulfill({ status: 500, json: { error: "The official CLI login did not start: fixture." } }) : route.continue(),
  );
  await context.route("**/api/providers/*/models", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3]!;
    if (failModels) {
      failModels = false; // the first answer fails; Retry then gets the list
      return route.fulfill({ status: 502, json: { error: "The models endpoint answered 502." } });
    }
    return route.fulfill({ json: { models: CATALOG[id] ?? [] } });
  });
  await context.route("**/api/providers/*/key", (route) => {
    if (route.request().method() === "PUT" && failKey) {
      failKey = false;
      return route.fulfill({ status: 500, json: { error: "The key could not be stored: fixture." } });
    }
    return route.continue();
  });
  await context.route("**/api/config/models", (route) => {
    if (route.request().method() === "PUT" && failSave) {
      failSave = false;
      return route.fulfill({ status: 500, json: { error: "config.toml could not be written: fixture." } });
    }
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(origin + path, { waitUntil: "domcontentloaded" });
  return { context, page };
}

const flowVisible = async (page: Page) => (await page.locator(".first-use .fu-card").count()) === 1;
const record = (page: Page) =>
  page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { done: boolean; mode: string }) : null;
  }, `doi:first-use:${workspace}`);
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

/** The one app-wide theme: the attribute, the stored choice and the painted colors. */
const themeState = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector(".first-use") as HTMLElement | null;
    const card = document.querySelector(".fu-card") as HTMLElement | null;
    return {
      attr: document.documentElement.dataset.theme ?? null,
      stored: localStorage.getItem("doi:theme"),
      paper: root ? getComputedStyle(root).backgroundColor : "",
      ink: root ? getComputedStyle(root).color : "",
      surface: card ? getComputedStyle(card).backgroundColor : "",
      colorScheme: root ? getComputedStyle(root).colorScheme : "",
    };
  });

const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
const luminance = ([r, g, b]: number[]) => {
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
};
/** WCAG contrast between an element's text and a background element (same one is allowed). */
async function contrast(page: Page, fg: string, bg: string): Promise<number> {
  const colors = await page.evaluate(
    ({ fg, bg }) => {
      const a = document.querySelector(fg) as HTMLElement | null;
      const b = document.querySelector(bg) as HTMLElement | null;
      if (!a || !b) return null;
      return { fg: getComputedStyle(a).color, bg: getComputedStyle(b).backgroundColor };
    },
    { fg, bg },
  );
  if (!colors) throw new Error(`missing element for contrast: ${fg} / ${bg}`);
  const [a, b] = [luminance(rgb(colors.fg)), luminance(rgb(colors.bg))].sort((x, y) => y - x) as [number, number];
  return (a + 0.05) / (b + 0.05);
}

/** The compact-window facts: no horizontal overflow, and Continue inside the viewport. */
const compactFacts = (page: Page) =>
  page.evaluate(() => {
    const button = document.querySelector(".fu-button.primary") as HTMLElement | null;
    button?.scrollIntoView({ block: "center" });
    const r = button?.getBoundingClientRect();
    const root = document.querySelector(".first-use") as HTMLElement | null;
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight,
      buttonTop: r?.top ?? -1,
      buttonBottom: r?.bottom ?? -1,
      background: root ? getComputedStyle(root).backgroundColor : "",
    };
  });

const FIT_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
  { width: 960, height: 560 },
  { width: 1440, height: 1080 },
  { width: 1920, height: 1080 },
];

describe.skipIf(!hasBrowser)("first-use flow in Chromium", () => {
  test("Connect → model → Ready saves, starts the editor and reopens from Settings; save failure stays", async () => {
    await Bun.write(configPath, BASELINE());
    const { context, page } = await open();
    try {
      await page.waitForSelector(".first-use .fu-card");
      expect(await page.title()).toBe("Connect · doi");
      expect(await page.locator(".fu-card h2").first().innerText()).toBe("Connect a provider");
      expect(await page.locator(".fu-step.is-active").innerText()).toContain("Connect");
      // The configured generate model is codex (the OpenAI vendor, OAuth, ready fixture).
      expect(await page.locator(".fu-provider-choice.is-checked").innerText()).toContain("OpenAI");
      expect(await page.locator(".fu-method-current").innerText()).toContain("ChatGPT subscription");
      expect(await page.locator(".fu-method-current").innerText()).toContain("Codex CLI");
      expect(await page.locator(".fu-button.primary").isEnabled()).toBe(true);
      await shot(page, "connect-1440");

      await page.locator(".fu-button.primary").click();
      await page.waitForSelector('.fu-card[aria-label="Choose a model"]');
      expect(await page.title()).toBe("Choose a model · doi");
      await page.waitForSelector("#fu-model:is(select)");
      expect(await page.locator("#fu-model").inputValue()).toBe("gpt-6.1-sol");
      await shot(page, "model-1440");

      // Back keeps a deliberate valid choice.
      await page.locator("#fu-model").selectOption("gpt-6");
      await page.locator(".fu-back-link").click();
      await page.waitForSelector(".fu-card .fu-provider-options");
      expect(await page.locator(".fu-provider-choice.is-checked").innerText()).toContain("OpenAI");
      await page.locator(".fu-button.primary").click();
      await page.waitForSelector("#fu-model:is(select)");
      expect(await page.locator("#fu-model").inputValue()).toBe("gpt-6");

      // A save error keeps the flow on the model step, marks nothing complete and shows the reason.
      failSave = true;
      await page.locator(".fu-button.primary").click();
      await page.waitForSelector('.fu-banner:has-text("The model was not saved")');
      expect(await flowVisible(page)).toBe(true);
      expect(await page.title()).toBe("Choose a model · doi");
      expect(await record(page)).toBeNull();
      expect(await page.locator(".fu-card").innerText()).toContain("config.toml could not be written: fixture.");

      // The same Continue now reaches the real save route.
      await page.locator(".fu-button.primary").click();
      await page.waitForSelector('.fu-card[aria-label="Ready"]');
      expect(await page.title()).toBe("Ready · doi");
      expect(await page.locator(".fu-card").innerText()).toContain("All connected");
      expect(await page.locator(".fu-card").innerText()).toContain("OpenAI");
      expect(await page.locator(".fu-card").innerText()).toContain("ChatGPT subscription · Codex CLI");
      expect(await page.locator(".fu-card").innerText()).toContain("gpt-6");
      expect(await page.locator(".fu-card").innerText()).toContain(workspace);
      expect((await readFile(configPath, "utf8")).includes('generate = "codex:gpt-6"')).toBe(true);
      await shot(page, "ready-1440");

      // Start designing opens the editor and focuses the composer.
      await page.locator(".fu-button.primary").click();
      await page.waitForSelector(".app .topbar");
      expect(await flowVisible(page)).toBe(false);
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Message");
      expect((await record(page))?.mode).toBe("saved");

      // A reload keeps the editor: this workspace is done.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".app .topbar");
      expect(await flowVisible(page)).toBe(false);

      // Settings opens the flow again for comparison; a reload then stays in the editor.
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.waitForSelector('[aria-modal="true"]');
      await page.getByRole("button", { name: "Open the setup flow" }).click();
      await page.waitForSelector(".first-use .fu-card");
      expect(await page.title()).toBe("Connect · doi");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".app .topbar");
      expect(await flowVisible(page)).toBe(false);

      // The direct comparison URL always shows the flow, also after a reload.
      await page.goto(`${origin}/?setup=1`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".first-use .fu-card");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".first-use .fu-card");
      expect(new URL(page.url()).searchParams.get("setup")).toBe("1");

      // Finishing the flow from that URL removes `setup`, so a reload shows the editor.
      await page.locator(".fu-button.primary").click();
      await page.waitForSelector("#fu-model:is(select)");
      await page.locator(".fu-button.primary").click();
      await page.waitForSelector('.fu-card[aria-label="Ready"]');
      await page.locator(".fu-button.primary").click();
      await page.waitForSelector(".app .topbar");
      expect(new URL(page.url()).searchParams.get("setup")).toBeNull();
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".app .topbar");
      expect(await flowVisible(page)).toBe(false);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("Explore without a model keeps the config and a deep link skips the flow", async () => {
    const { context, page } = await open();
    try {
      await page.waitForSelector(".first-use .fu-card");
      const before = await readFile(configPath, "utf8");
      await page.getByRole("button", { name: "Explore without a model" }).click();
      await page.waitForSelector(".app .topbar");
      expect(await flowVisible(page)).toBe(false);
      expect((await record(page))?.mode).toBe("skip");
      expect(await readFile(configPath, "utf8")).toBe(before);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".app .topbar");
      expect(await flowVisible(page)).toBe(false);
      // The projects of the workspace are still there: the flow removed nothing.
      await page.getByRole("button", { name: "Projects and designs" }).click();
      await page.waitForSelector('.nav-drawer[aria-label="Projects"]');
      expect(await page.locator(".nav-project-name").first().innerText()).toBe("Sample");
    } finally {
      await context.close();
    }

    // A valid design link opens its target without a first-use interruption.
    const deep = await open("/?project=sample&design=home");
    try {
      await deep.page.waitForSelector(".app .topbar");
      expect(await flowVisible(deep.page)).toBe(false);
      expect(new URL(deep.page.url()).searchParams.get("project")).toBe("sample");
      await deep.page.waitForSelector(".canvas, .canvas-body, .frame", { timeout: 10_000 }).catch(() => {});
    } finally {
      await deep.context.close();
    }
  }, 45_000);

  test("the flow covers the editor: no canvas, no hidden shortcut, and every control is reachable when small", async () => {
    const { context, page } = await open();
    try {
      await page.waitForSelector(".first-use .fu-card");
      await page.waitForSelector(".fu-provider-options");
      // No editor under the flow, so a canvas key or a drawer key cannot act on a hidden screen.
      expect(await page.locator(".app, .canvas, .nav-drawer, [aria-modal=\"true\"]").count()).toBe(0);
      for (const key of ["c", "v", "t", "Escape"]) await page.keyboard.press(key);
      await page.keyboard.press("Control+p");
      await page.waitForTimeout(100);
      expect(await page.locator(".app, .canvas, .nav-drawer, [aria-modal=\"true\"]").count()).toBe(0);
      expect(await flowVisible(page)).toBe(true);
      expect(await page.locator(".fu-step.is-active").innerText()).toContain("Connect");

      // Below the app's minimum size the flow scrolls; no control sits outside the page.
      await page.setViewportSize({ width: 900, height: 520 });
      await page.waitForTimeout(100);
      const small = await page.evaluate(() => {
        const button = document.querySelector(".fu-button.primary") as HTMLElement | null;
        button?.scrollIntoView({ block: "center" });
        const r = button?.getBoundingClientRect();
        return {
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth,
          scrollHeight: document.documentElement.scrollHeight,
          innerHeight,
          buttonTop: r?.top ?? -1,
          buttonBottom: r?.bottom ?? -1,
        };
      });
      expect(small.scrollWidth <= small.innerWidth).toBe(true);
      expect(small.scrollHeight > small.innerHeight).toBe(true);
      expect(small.buttonTop >= 0 && small.buttonBottom <= small.innerHeight).toBe(true);
      expect(await page.getByRole("button", { name: "Explore without a model" }).isVisible()).toBe(true);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("provider load failure, missing readiness, login failure, API-key method, list retry, typed model, keyboard, compact", async () => {
    codexReady = false;
    failProviders = true;
    const { context, page } = await open();
    try {
      await page.waitForSelector(".first-use .fu-card");
      // A provider status failure names the problem and offers the check again; no method is guessed.
      await page.waitForSelector('.fu-banner:has-text("The provider status could not load")');
      expect(await page.locator(".fu-provider-options").count()).toBe(0);
      expect(await page.locator(".fu-button.primary").count()).toBe(0);
      failProviders = false;
      await page.getByRole("button", { name: "Check again" }).click();
      await page.waitForSelector(".fu-provider-options");

      // Codex is logged out: Continue is off, the reason is actionable and login is a user action.
      expect(await page.locator(".fu-button.primary").isDisabled()).toBe(true);
      expect(await page.locator(".fu-action-note").innerText()).toContain("Not logged in");
      expect(await page.getByRole("button", { name: "Log in" }).count()).toBe(1);

      // A failed official login shows the server's reason and keeps the flow on Connect.
      failLogin = true;
      await page.getByRole("button", { name: "Log in" }).click();
      await page.waitForSelector('.fu-banner:has-text("The official CLI login did not start")');
      expect(await page.locator(".fu-button.primary").isDisabled()).toBe(true);
      failLogin = false;

      // The API-key alternative really selects the API provider, not the logged-out CLI.
      await page.locator(".fu-alternative").click();
      expect(await page.locator(".fu-method-current").innerText()).toContain("API key");
      expect(await page.locator(".fu-method-current").innerText()).toContain("OpenAI");
      expect(await page.locator("#fu-key").getAttribute("type")).toBe("password");
      expect(await page.locator(".fu-button.primary").isDisabled()).toBe(true);
      expect(await page.locator(".fu-action-note").innerText()).toContain("API key");

      // Provider switch clears the old model choice and shows the new provider catalog.
      await page.locator(".fu-provider-choice", { hasText: "Anthropic" }).click();
      expect(await page.locator(".fu-provider-choice.is-checked").innerText()).toContain("Anthropic");
      expect(await page.locator(".fu-method-current").innerText()).toContain("Claude subscription");
      expect(await page.locator(".fu-button.primary").isEnabled()).toBe(true);

      // A fixture: the model list fails once; Retry loads it, and a typed id is validated meanwhile.
      failModels = true;
      await page.locator(".fu-button.primary").click();
      await page.waitForSelector('.fu-banner:has-text("The model list could not load")');
      expect(await page.locator(".fu-button.primary").isDisabled()).toBe(true);
      const input = page.locator("#fu-model");
      await input.fill("--bad");
      expect(await input.getAttribute("aria-invalid")).toBe("true");
      expect(await page.locator(".fu-button.primary").isDisabled()).toBe(true);
      await input.fill("claude-opus-5-5");
      expect(await input.getAttribute("aria-invalid")).toBe("false");
      expect(await page.locator(".fu-button.primary").isEnabled()).toBe(true);
      await page.getByRole("button", { name: "Retry" }).click();
      // The typed value stays; List returns to the provider catalog.
      await page.waitForSelector('.fu-model-label-row button:has-text("List")');
      expect(await page.locator("#fu-model").inputValue()).toBe("claude-opus-5-5");
      await page.getByRole("button", { name: "List" }).click();
      await page.waitForSelector("#fu-model:is(select)");
      expect(await page.locator("#fu-model").inputValue()).toBe("claude-opus-5-5");

      // A typed id is a deliberate choice, and List goes back to the catalog.
      await page.locator("#fu-model").selectOption(" type");
      await page.locator("#fu-model").fill("claude-sonnet-5-5");
      expect(await page.locator(".fu-button.primary").isEnabled()).toBe(true);
      await page.getByRole("button", { name: "List" }).click();
      await page.waitForSelector("#fu-model:is(select)");
      expect(await page.locator("#fu-model").inputValue()).toBe("claude-sonnet-5-5");

      // Back to Connect, then the compact window: no horizontal overflow, Continue reachable.
      await page.locator(".fu-back-link").click();
      await page.waitForSelector(".fu-provider-options");
      await page.setViewportSize({ width: 960, height: 560 });
      await page.waitForTimeout(100);
      const compact = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        width: innerWidth,
        scrollHeight: document.documentElement.scrollHeight,
        height: innerHeight,
        continueBottom: document.querySelector(".fu-button.primary")?.getBoundingClientRect().bottom ?? 0,
      }));
      expect(compact.scrollWidth <= compact.width).toBe(true);
      expect(compact.continueBottom <= compact.height).toBe(true);
      await shot(page, "connect-960");

      // Native radios, keyboard focus and arrow keys work. Tab comes from the step button, so
      // this is real keyboard navigation, not a programmatic focus.
      await page.locator(".fu-step").nth(1).focus();
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => document.activeElement?.className ?? "");
      expect(focused).toContain("fu-provider-radio");
      const radio = page.locator(".fu-provider-radio:focus");
      expect(await radio.evaluate((el) => (el as HTMLInputElement).labels?.length)).toBe(1);
      const outline = await page.locator(".fu-provider-choice:has(.fu-provider-radio:focus)").evaluate((el) => getComputedStyle(el).outlineStyle);
      expect(["solid", "auto"]).toContain(outline);
      const before = await page.locator(".fu-provider-choice.is-checked").innerText();
      await page.keyboard.press("ArrowRight");
      const after = await page.locator(".fu-provider-choice.is-checked").innerText();
      expect(after).not.toBe(before);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a model choice belongs to its provider and does not follow a vendor switch", async () => {
    const { context, page } = await open();
    try {
      await page.waitForSelector(".first-use .fu-card");
      await page.waitForSelector(".fu-provider-options");
      // OpenAI (fixture: Codex logged in) opens on the configured model.
      await page.locator(".fu-button.primary").click();
      await page.waitForSelector("#fu-model:is(select)");
      expect(await page.locator("#fu-model").inputValue()).toBe("gpt-6.1-sol");
      await page.locator("#fu-model").selectOption("gpt-6");
      // Another vendor clears that choice: its list is a different list.
      await page.locator(".fu-back-link").click();
      await page.locator(".fu-provider-choice", { hasText: "Anthropic" }).click();
      await page.locator(".fu-button.primary").click();
      await page.waitForSelector("#fu-model:is(select)");
      const models = await page.locator("#fu-model option").evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
      expect(models).toContain("claude-opus-5-5");
      expect(models).not.toContain("gpt-6");
      expect(await page.locator("#fu-model").inputValue()).toBe("claude-opus-5-5");
    } finally {
      await context.close();
    }
  }, 30_000);

  test("dark theme follows the system, both explicit choices persist, and every step and the editor use it", async () => {
    const { context, page } = await open("/", { width: 1440, height: 900 }, "dark");
    try {
      await page.waitForSelector(".first-use .fu-card");
      await page.waitForSelector(".fu-provider-options");
      const initial = await themeState(page);
      expect(initial.attr).toBeNull();
      expect(initial.stored).toBeNull();
      expect(initial.paper).toBe("rgb(20, 20, 19)");
      expect(initial.surface).toBe("rgb(30, 30, 27)");
      expect(initial.colorScheme).toBe("dark");
      expect(await page.getByRole("button", { name: "Switch to light theme" }).count()).toBe(1);

      // Body text, muted text, the active step, the footer and the primary label are readable.
      for (const [fg, bg] of [
        [".first-use", ".first-use"],
        [".fu-lead", ".first-use"],
        [".fu-card", ".fu-card"],
        [".fu-card-intro", ".fu-card"],
        [".fu-step.is-active", ".first-use"],
        [".fu-footer", ".first-use"],
        [".fu-button.primary", ".fu-button.primary"],
      ] as const) {
        expect(await contrast(page, fg, bg)).toBeGreaterThanOrEqual(4.5);
      }
      await shot(page, "connect-1440-dark");

      // The control keeps the step; an explicit light choice wins over the dark system.
      await page.getByRole("button", { name: "Switch to light theme" }).click();
      expect(await page.locator(".fu-step.is-active").innerText()).toContain("Connect");
      expect(await themeState(page)).toMatchObject({ attr: "light", stored: "light", paper: "rgb(246, 245, 240)", surface: "rgb(253, 252, 248)", colorScheme: "light" });
      await shot(page, "connect-1440-light");

      // A reload keeps the explicit light choice even though the system is dark.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".fu-provider-options");
      expect(await themeState(page)).toMatchObject({ attr: "light", stored: "light", paper: "rgb(246, 245, 240)" });
      expect(await page.getByRole("button", { name: "Switch to dark theme" }).count()).toBe(1);

      // An explicit dark choice, then the same choice on every step and in the editor.
      await page.getByRole("button", { name: "Switch to dark theme" }).click();
      expect(await themeState(page)).toMatchObject({ attr: "dark", stored: "dark", paper: "rgb(20, 20, 19)" });
      await page.locator(".fu-button.primary").click();
      await page.waitForSelector("#fu-model:is(select)");
      expect((await themeState(page)).paper).toBe("rgb(20, 20, 19)");
      await shot(page, "model-1440-dark");

      // A draft survives a theme change on the model step.
      await page.locator("#fu-model").selectOption("gpt-6");
      await page.getByRole("button", { name: "Switch to light theme" }).click();
      expect(await page.locator("#fu-model").inputValue()).toBe("gpt-6");
      await page.getByRole("button", { name: "Switch to dark theme" }).click();
      expect(await page.locator("#fu-model").inputValue()).toBe("gpt-6");
      expect(await page.locator(".fu-step.is-active").innerText()).toContain("Choose a model");

      await page.locator(".fu-button.primary").click();
      await page.waitForSelector('.fu-card[aria-label="Ready"]');
      expect(await themeState(page)).toMatchObject({ attr: "dark", stored: "dark", paper: "rgb(20, 20, 19)", surface: "rgb(30, 30, 27)" });
      await shot(page, "ready-1440-dark");

      await page.locator(".fu-button.primary").click();
      await page.waitForSelector(".app .topbar");
      // The editor uses the same choice and the same storage key; there is no second state.
      expect(await page.evaluate(() => ({ attr: document.documentElement.dataset.theme ?? null, stored: localStorage.getItem("doi:theme") }))).toEqual({ attr: "dark", stored: "dark" });
      expect(await page.getByRole("button", { name: "Switch to light theme" }).count()).toBe(1);
    } finally {
      await context.close();
    }
  }, 90_000);

  test("system light with no choice follows a live system change; an explicit light choice wins", async () => {
    const { context, page } = await open();
    try {
      await page.waitForSelector(".first-use .fu-card");
      expect(await themeState(page)).toMatchObject({ attr: null, stored: null, paper: "rgb(246, 245, 240)", colorScheme: "light" });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".first-use")!).backgroundColor === "rgb(20, 20, 19)");
      expect(await themeState(page)).toMatchObject({ attr: null, stored: null, paper: "rgb(20, 20, 19)", colorScheme: "dark" });
      await page.emulateMedia({ colorScheme: "light" });
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".first-use")!).backgroundColor === "rgb(246, 245, 240)");
      expect((await themeState(page)).attr).toBeNull();

      // Explicit light, chosen while the system is dark.
      await page.emulateMedia({ colorScheme: "dark" });
      await page.getByRole("button", { name: "Switch to light theme" }).click();
      expect(await themeState(page)).toMatchObject({ attr: "light", stored: "light", paper: "rgb(246, 245, 240)" });
      await page.emulateMedia({ colorScheme: "light" });
      expect((await themeState(page)).paper).toBe("rgb(246, 245, 240)");
      await page.emulateMedia({ colorScheme: "dark" });
      expect((await themeState(page)).paper).toBe("rgb(246, 245, 240)");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".first-use .fu-card");
      expect(await themeState(page)).toMatchObject({ attr: "light", stored: "light", paper: "rgb(246, 245, 240)" });
    } finally {
      await context.close();
    }
  }, 45_000);

  test("both themes fit the compact window and the theme control takes keyboard focus", async () => {
    const { context, page } = await open("/", { width: 960, height: 560 }, "dark");
    try {
      await page.waitForSelector(".fu-provider-options");
      // The header control is the first stop in the tab order and shows a visible focus ring.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.className ?? "")).toContain("fu-theme");
      expect(["solid", "auto"]).toContain(await page.locator(".fu-theme").evaluate((el) => getComputedStyle(el).outlineStyle));
      const dark = await compactFacts(page);
      expect(dark.scrollWidth <= dark.innerWidth).toBe(true);
      expect(dark.buttonTop >= 0 && dark.buttonBottom <= dark.innerHeight).toBe(true);
      expect(dark.background).toBe("rgb(20, 20, 19)");
      await shot(page, "connect-960-dark");

      // Enter is a real keyboard action on the control.
      await page.keyboard.press("Enter");
      const light = await compactFacts(page);
      expect(light.scrollWidth <= light.innerWidth).toBe(true);
      expect(light.buttonTop >= 0 && light.buttonBottom <= light.innerHeight).toBe(true);
      expect(light.background).toBe("rgb(246, 245, 240)");
      expect((await themeState(page)).stored).toBe("light");
      await shot(page, "connect-960-light");
    } finally {
      await context.close();
    }
  }, 45_000);

  for (const theme of ["light", "dark"] as const) {
    test(`all three ${theme} steps keep the original spacing and allow page scroll`, async () => {
      const { context, page } = await open("/?setup=1", { width: 1440, height: 900 }, theme);
      const viewports = FIT_VIEWPORTS;
      try {
        await page.waitForSelector(".fu-provider-options");
        await page.evaluate(() => document.fonts.ready);
        for (const step of ["connect", "model", "ready"]) {
          for (const viewport of viewports) {
            await page.setViewportSize(viewport);
            const facts = await page.evaluate(() => {
              const doc = document.scrollingElement!;
              const footer = document.querySelector(".fu-footer")!.getBoundingClientRect();
              const content = document.querySelector(".fu-layout")!.getBoundingClientRect();
              const action = document.querySelector(".fu-button.primary")!.getBoundingClientRect();
              const innerScroll = [...document.querySelectorAll<HTMLElement>(".first-use, .first-use *")]
                .filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1)
                .map((el) => el.className);
              return {
                noVerticalScroll: doc.scrollHeight <= doc.clientHeight,
                noHorizontalScroll: doc.scrollWidth <= doc.clientWidth,
                footerVisible: footer.top >= 0 && footer.bottom <= innerHeight,
                footerAfterContent: footer.top >= content.bottom,
                footerMargin: parseFloat(getComputedStyle(document.querySelector(".fu-footer")!).marginTop),
                contentTop: content.top,
                cardPaddingTop: parseFloat(getComputedStyle(document.querySelector('.fu-card')!).paddingTop),
                cardPaddingBottom: parseFloat(getComputedStyle(document.querySelector('.fu-card')!).paddingBottom),
                actionVisible: action.top >= 0 && action.bottom <= innerHeight,
                innerScroll,
                height: doc.scrollHeight,
                footerBottom: footer.bottom,
              };
            });
            expect({ step, theme, viewport, ...facts }).toMatchObject({
              noHorizontalScroll: true,
              footerAfterContent: true,
              innerScroll: [],
            });
            expect(facts.footerMargin).toBe(viewport.height <= 760 ? 12 : 24);
            expect(facts.cardPaddingTop).toBe(viewport.height <= 760 ? 12 : 24);
            expect(facts.cardPaddingBottom).toBe(viewport.height <= 760 ? 12 : 24);
            if (viewport.height <= 760 || viewport.height >= 900) {
              expect(facts.noVerticalScroll).toBe(true);
              expect(facts.footerVisible).toBe(true);
              expect(facts.actionVisible).toBe(true);
            }
            if (viewport.width === 1440 && viewport.height === 900) expect(facts.contentTop).toBe(225);
            if (viewport.width === 1366 && viewport.height === 768) {
              expect(facts.contentTop).toBe(225);
              if (step === "connect") {
                expect(facts.noVerticalScroll).toBe(false);
                expect(facts.height).toBe(876);
              }
            }
            if ((viewport.width === 1366 || viewport.width === 1440) && viewport.height <= 900) {
              await shot(page, `footer-${step}-${theme}-${viewport.width}`);
            }
          }
          if (step !== "ready") {
            await page.locator(".fu-button.primary").click();
            await page.waitForSelector(step === "connect" ? "#fu-model:is(select)" : '.fu-card[aria-label="Ready"]');
          }
        }
      } finally {
        await context.close();
      }
    }, 45_000);

    test(`the revised privacy sentence appears in ${theme} after reload`, async () => {
      const { context, page } = await open("/?setup=1", { width: 1366, height: 768 }, theme);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          await page.waitForSelector(".fu-lead");
          expect(await page.locator(".fu-lead").innerText()).toContain("Your designs stay on your computer.");
          expect(await page.locator(".first-use").innerText()).not.toContain("Your designs stay on this computer.");
          if (attempt === 0) await page.reload({ waitUntil: "domcontentloaded" });
        }
      } finally {
        await context.close();
      }
    });
  }

  test("the theme control works before any provider status is ready", async () => {
    providerGate = new Promise((resolve) => {
      releaseProviders = resolve;
    });
    const { context, page } = await open();
    try {
      await page.waitForSelector(".first-use .fu-card");
      await page.waitForSelector(".fu-loading");
      expect(await page.locator(".fu-provider-options").count()).toBe(0);
      expect(await page.getByRole("button", { name: "Switch to dark theme" }).isVisible()).toBe(true);
      await page.getByRole("button", { name: "Switch to dark theme" }).click();
      expect(await themeState(page)).toMatchObject({ attr: "dark", stored: "dark", paper: "rgb(20, 20, 19)" });
      releaseProviders?.();
      providerGate = null;
      await page.waitForSelector(".fu-provider-options");
      expect((await themeState(page)).paper).toBe("rgb(20, 20, 19)");
      expect(await page.locator(".fu-step.is-active").innerText()).toContain("Connect");
    } finally {
      releaseProviders?.();
      providerGate = null;
      await context.close();
    }
  }, 30_000);

  test("dark status and error text stay readable", async () => {
    failProviders = true;
    const { context, page } = await open("/", { width: 1440, height: 900 }, "dark");
    try {
      await page.waitForSelector('.fu-banner:has-text("The provider status could not load")');
      expect(await contrast(page, ".fu-banner", ".fu-banner")).toBeGreaterThanOrEqual(4.5);
      expect(await contrast(page, ".fu-banner .fu-link", ".fu-banner")).toBeGreaterThanOrEqual(4.5);
      failProviders = false;
      codexReady = false;
      await page.getByRole("button", { name: "Check again" }).click();
      await page.waitForSelector(".fu-provider-options");
      await page.waitForSelector(".fu-action-note.is-blocked");
      expect(await contrast(page, ".fu-action-note.is-blocked", ".fu-card")).toBeGreaterThanOrEqual(4.5);
      expect(await contrast(page, ".fu-login-state p", ".fu-card")).toBeGreaterThanOrEqual(4.5);
    } finally {
      await context.close();
    }
  }, 45_000);

  test("a key-save failure is shown and leaves the method unready", async () => {
    const { context, page } = await open();
    try {
      await page.waitForSelector(".first-use .fu-card");
      await page.locator(".fu-provider-choice", { hasText: "OpenCode Go" }).click();
      expect(await page.locator(".fu-method-current").innerText()).toContain("API key");
      expect(await page.locator(".first-use").innerText()).not.toContain("doi sends the key only");
      expect(await page.locator(".first-use").innerText()).not.toContain("The key is never shown again.");
      expect(await page.locator("#fu-key").getAttribute("type")).toBe("password");
      failKey = true;
      await page.locator("#fu-key").fill("sk-test-fixture");
      await page.getByRole("button", { name: "Save key" }).click();
      await page.waitForSelector('.fu-banner:has-text("The key could not be stored")');
      expect(await page.locator("#fu-key").inputValue()).toBe("sk-test-fixture");
      expect(await page.locator(".fu-button.primary").isDisabled()).toBe(true);
      // The key is not in the page text or an attribute that the UI shows.
      expect(await page.locator(".first-use").innerText()).not.toContain("sk-test-fixture");

      // The same route succeeds next, clears the field, and Check again enables Continue.
      await page.getByRole("button", { name: "Save key" }).click();
      await page.waitForSelector('.fu-note:has-text("Saved in")');
      expect(await page.locator("#fu-key").inputValue()).toBe("");
      opencodeReady = true;
      await page.getByRole("button", { name: "Check again" }).click();
      await page.waitForFunction(() => {
        const button = document.querySelector(".fu-button.primary") as HTMLButtonElement | null;
        return !!button && !button.disabled;
      });
    } finally {
      await context.close();
    }
  }, 30_000);
});
