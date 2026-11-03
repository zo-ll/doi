import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { loadConfig } from "../src/config.ts";
import type { ProviderStatus } from "../src/providers/status.ts";
import { startServer } from "../src/server/app.ts";

const hasBrowser = await chromium.launch().then(
  (browser) => browser.close().then(() => true),
  () => false,
);
test.if(!!process.env.CI)("CI has Chromium for Settings", () => expect(hasBrowser).toBe(true));

test.skipIf(!hasBrowser)("a saved model id loses outer spaces and clears the dirty state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "doi-settings-browser-"));
  const path = join(dir, "config.toml");
  const model = "deepseek-v4.1-flash";
  await Bun.write(path, `workspace = "./workspace"\n[models]\ngenerate = "opencode-go:${model}"\nedit = "opencode-go:${model}"\nextract = "opencode-go:${model}"\n`);
  let browser: Browser | undefined;
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await startServer(await loadConfig(path), { port: 0, development: false });
    browser = await chromium.launch();
    const providers = [{ id: "opencode-go", source: "api_key", ready: true, detail: "Test key fixture", implemented: true, keyFrom: "file" }] satisfies ProviderStatus[];
    for (const perTask of [false, true]) {
      const context = await browser.newContext();
      try {
        // Only provider metadata uses fixtures. The config save and reload use the real server.
        await context.route("**/api/providers", (route) => route.fulfill({ json: providers }));
        await context.route("**/api/providers/opencode-go/models", (route) => route.fulfill({ json: { models: [model], fixed: false } }));
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${app.server.port}/`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        if (perTask) await page.getByRole("button", { name: "Use a different model per task" }).click();
        const label = perTask ? "Generate model" : "All tasks model";
        await page.getByLabel(label, { exact: true }).selectOption({ label: "Type a model id…" });
        const field = page.getByLabel(label, { exact: true });
        await field.fill(` ${model} `);
        const save = page.locator(".settings-actions").getByRole("button", { name: "Save", exact: true });
        expect(await save.isEnabled()).toBe(true);
        await save.click();
        await page.getByText("Saved. The next turn uses these models.", { exact: true }).waitFor({ timeout: 3000 });
        expect(await field.inputValue()).toBe(model);
        expect(await save.isDisabled()).toBe(true);
        const saved = await loadConfig(path);
        expect(saved.models.generate.model).toBe(model);
        expect(saved.models.edit.model).toBe(model);
        expect(saved.models.extract.model).toBe(model);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        expect(await page.getByLabel("All tasks model", { exact: true }).inputValue()).toBe(model);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    app?.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
