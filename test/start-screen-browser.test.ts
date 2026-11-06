import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { parseConfig } from "../src/config.ts";
import { startServer } from "../src/server/app.ts";
import { createNode } from "../src/architecture/nodes.ts";
import { createDiagram } from "../src/architecture/schema.ts";
import { writeArchitecture } from "../src/workspace/architecture.ts";
import { createProject } from "../src/workspace/projects.ts";

const hasBrowser = await chromium.launch().then(
  (browser) => browser.close().then(() => true),
  () => false,
);
test.if(!!process.env.CI)("CI has Chromium for the start screen checks", () => expect(hasBrowser).toBe(true));

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const sse = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
type Turn = { url: string; body: { text: string; images?: unknown[]; model?: string; target?: string | null } };
type Drive = { page: Page; context: BrowserContext; origin: string; workspace: string; turns: Turn[] };

async function drive(prepare: (workspace: string) => Promise<void>, run: (d: Drive) => Promise<void>, path = "/") {
  const workspace = await mkdtemp(join(tmpdir(), "doi-start-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  const browser = await chromium.launch();
  try {
    await prepare(workspace);
    const context = await browser.newContext();
    await context.route("**/api/providers", (route) => route.fulfill({ json: [] }));
    const turns: Turn[] = [];
    await context.route("**/api/projects/*/designs/*/turns", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      turns.push({ url: route.request().url(), body: route.request().postDataJSON() as Turn["body"] });
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse([{ type: "text", delta: "I make the first screen." }, { type: "done" }]) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const origin = `http://127.0.0.1:${app.server.port}`;
    await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
    await run({ page, context, origin, workspace, turns });
  } finally {
    await browser.close();
    app.stop();
    await rm(workspace, { recursive: true, force: true });
  }
}

const start = (page: Page) => page.getByRole("dialog", { name: "Start a new project" });
const projectsOf = async (origin: string) => (await (await fetch(`${origin}/api/projects`)).json()) as { id: string; name: string; designs: string[]; apps: string[]; decks: string[]; repo?: { name: string } | null }[];

for (const [title, kind] of [["Web", "page"], ["Mobile app", "app"], ["Slide deck", "slides"]] as const) {
  test.skipIf(!hasBrowser)(`first start: ${title} goes from the screen to a running first turn`, async () => {
    await drive(async () => {}, async ({ page, origin, workspace, turns }) => {
      await start(page).waitFor();
      await start(page).getByRole("radio", { name: new RegExp(`^${title}`) }).click();
      await start(page).getByLabel("First prompt").fill("A quiet place for notes, with search and tags and more words");
      await start(page).getByRole("button", { name: "Start", exact: true }).click();
      await start(page).waitFor({ state: "detached" });
      await page.getByText("I make the first screen.").waitFor();
      expect(turns).toHaveLength(1);
      expect(turns[0]!.url).toContain("/api/projects/a-quiet-place-for-notes-with/designs/home/turns");
      expect(turns[0]!.body.text).toBe("A quiet place for notes, with search and tags and more words");
      const project = (await projectsOf(origin)).find((p) => p.id === "a-quiet-place-for-notes-with")!;
      expect(project.name).toBe("A quiet place for notes, with");
      expect(project.designs).toEqual(["home"]);
      expect(project.apps).toEqual(kind === "app" ? ["home"] : []);
      expect(project.decks).toEqual(kind === "slides" ? ["home"] : []);
      await page.waitForFunction(() => location.search.includes("a-quiet-place-for-notes-with"));
      // The frames follow the project list, which loads again after the start.
      const want = kind === "page" ? "Desktop,Mobile" : kind === "app" ? "index" : "Slide";
      await page.waitForFunction((w) => [...document.querySelectorAll(".frame-name")].map((e) => e.textContent).join(",") === w, want);
      expect((await Bun.$`git log -1 --format=%s -- projects/a-quiet-place-for-notes-with`.cwd(workspace).text()).trim()).toContain("Create project");
    });
  }, 30_000);
}

/** Every model of the config is ready, and `generate` has no vision. */
async function modelsReady(context: BrowserContext) {
  await context.route("**/api/providers", (route) => route.fulfill({ json: [{ id: "claude-code", source: "cli", ready: true, detail: "", implemented: true }] }));
  await context.route("**/api/config", async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as { vision: Record<string, boolean | null> };
    await route.fulfill({ response, json: { ...config, vision: { ...config.vision, generate: false, edit: true } } });
  });
}

test.skipIf(!hasBrowser)("the vision warning stops the start until the user picks a model with vision, and the first turn uses that model", async () => {
  await drive(async () => {}, async ({ page, context, origin, turns }) => {
    await modelsReady(context);
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await start(page).waitFor();
    await start(page).locator(".model-chip").waitFor();
    await start(page).locator("input[type=file]").setInputFiles({ name: "sketch.png", mimeType: "image/png", buffer: PNG });
    await start(page).getByLabel("First prompt").fill("A page like this sketch");
    await start(page).getByText("cannot read images").waitFor();
    expect(await start(page).getByRole("button", { name: "Start", exact: true }).isDisabled()).toBe(true);
    await start(page).getByRole("button", { name: "Pick a model" }).click();
    const withVision = page.locator(".model-menu .menu-item[role=menuitemradio]").filter({ hasNotText: "No images" }).first();
    const model = await withVision.locator(".mono").textContent();
    await withVision.click();
    await start(page).getByRole("button", { name: "Start", exact: true }).click();
    await page.getByText("I make the first screen.").waitFor();
    expect(turns[0]!.body.model).toContain(model!);
    expect(turns[0]!.body.images).toHaveLength(1);
  });
}, 30_000);

test.skipIf(!hasBrowser)("the first turn goes once, with its images; a reload does not send it again", async () => {
  await drive(async () => {}, async ({ page, turns }) => {
    await start(page).waitFor();
    await start(page).locator("input[type=file]").setInputFiles({ name: "sketch.png", mimeType: "image/png", buffer: PNG });
    await start(page).locator(".composer-thumb img").first().waitFor();
    await start(page).getByLabel("First prompt").fill("A page like this sketch");
    await start(page).getByLabel("First prompt").press("Control+Enter");
    await page.getByText("I make the first screen.").waitFor();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.body.images).toHaveLength(1);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".frame-name").first().waitFor();
    await Bun.sleep(300);
    expect(turns).toHaveLength(1);
    expect(await start(page).count()).toBe(0);
  });
}, 30_000);

test.skipIf(!hasBrowser)("a taken name gets a number, and a prompt without Latin letters still makes a project", async () => {
  await drive(async (workspace) => void (await createProject(workspace, "Same words")), async ({ page, origin, turns }) => {
    await page.locator(".frame-name").first().waitFor();
    await page.getByRole("button", { name: "Projects and designs" }).click();
    await page.getByRole("button", { name: "New project" }).click();
    await start(page).getByLabel("First prompt").fill("Same words");
    await start(page).getByRole("button", { name: "Start", exact: true }).click();
    await page.getByText("I make the first screen.").waitFor();
    expect((await projectsOf(origin)).find((p) => p.id === "same-words-2")?.name).toBe("Same words 2");

    await page.getByRole("button", { name: "Projects and designs" }).click();
    await page.getByRole("button", { name: "New project" }).click();
    await start(page).getByLabel("First prompt").fill("日本語のページ");
    await start(page).getByRole("button", { name: "Start", exact: true }).click();
    await page.waitForFunction(() => location.search.includes("project=project"));
    await page.locator(".chat").getByText("I make the first screen.").waitFor();
    expect((await projectsOf(origin)).find((p) => p.id === "project")?.name).toBe("日本語のページ");
    expect(turns).toHaveLength(2);
  });
}, 30_000);

test.skipIf(!hasBrowser)("an existing project opens as before; New project opens the screen, and Esc closes it", async () => {
  await drive(async (workspace) => void (await createProject(workspace, "Mine")), async ({ page }) => {
    await page.locator(".frame-name").first().waitFor();
    expect(await start(page).count()).toBe(0);
    await page.getByRole("button", { name: "Projects and designs" }).click();
    await page.getByRole("button", { name: "New project" }).click();
    await start(page).waitFor();
    await page.keyboard.press("Escape");
    await start(page).waitFor({ state: "detached" });
    await page.locator(".frame-name").first().waitFor();
  });
}, 30_000);

test.skipIf(!hasBrowser)("a kept UML edit keeps the screen, the prompt and the one project; the next Start goes on", async () => {
  const prepare = async (workspace: string) => {
    const node = createNode("box", { x: 80, y: 80 }, "Saved name");
    await writeArchitecture(workspace, "sample", null, { version: 1, enabled: true, diagrams: [{ ...createDiagram(), nodes: [node] }] });
  };
  await drive(prepare, async ({ page, context, origin, turns }) => {
    // A save that does not end keeps the edit unsaved.
    await context.route("**/api/projects/sample/architecture", async (route) => {
      if (route.request().method() === "PUT") return;
      await route.continue();
    });
    await page.getByRole("tab", { name: "UML", exact: true }).click();
    await page.getByRole("button", { name: /System overview/ }).click();
    await page.getByRole("group", { name: "Saved name", exact: true }).click();
    await page.getByRole("textbox", { name: "Box name", exact: true }).fill("Unsaved name");
    await page.locator(".uml-save-state").filter({ hasNotText: /^Saved$/ }).waitFor();

    await page.getByRole("button", { name: "Projects and designs" }).click();
    await page.getByRole("button", { name: "New project" }).click();
    await start(page).getByLabel("First prompt").fill("A page after the diagram");
    let accept = false;
    page.on("dialog", (d) => void (accept ? d.accept() : d.dismiss()));
    await start(page).getByRole("button", { name: "Start", exact: true }).click();
    const again = start(page).getByRole("button", { name: "Start", exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "Start" && !b.disabled));
    expect(await start(page).getByLabel("First prompt").inputValue()).toBe("A page after the diagram");
    expect(turns).toHaveLength(0);
    // The project exists: its kind cannot change, and the screen says so.
    expect(await start(page).getByRole("radio", { name: /^Mobile app/ }).isDisabled()).toBe(true);
    await start(page).getByText("The project is made").waitFor();
    accept = true;
    await again.click();
    await page.getByText("I make the first screen.").waitFor();
    expect(turns).toHaveLength(1);
    expect((await projectsOf(origin)).filter((p) => p.id.startsWith("a-page-after")).map((p) => p.id)).toEqual(["a-page-after-the-diagram"]);
  }, "/?project=sample&design=home");
}, 30_000);

test.skipIf(!hasBrowser)("Esc closes the model menu first, and the screen after it", async () => {
  await drive(async (workspace) => void (await createProject(workspace, "Mine")), async ({ page }) => {
    await page.locator(".frame-name").first().waitFor();
    await page.getByRole("button", { name: "Projects and designs" }).click();
    await page.getByRole("button", { name: "New project" }).click();
    await start(page).locator(".model-chip").click();
    await page.locator(".model-menu").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".model-menu").waitFor({ state: "detached" });
    expect(await start(page).count()).toBe(1);
    await page.keyboard.press("Escape");
    await start(page).waitFor({ state: "detached" });
  });
}, 30_000);

test.skipIf(!hasBrowser)("after Open the sample, a delete that empties the workspace shows the screen again", async () => {
  await drive(async () => {}, async ({ page }) => {
    await start(page).getByRole("button", { name: "Open the sample" }).click();
    await page.locator(".frame-name").first().waitFor();
    await page.getByRole("button", { name: "Projects and designs" }).click();
    await page.getByTitle("Delete Sample").click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete project" }).click();
    await start(page).waitFor();
  });
}, 30_000);

test.skipIf(!hasBrowser)("a slow chat load does not show the first message twice", async () => {
  await drive(async () => {}, async ({ page, context, turns }) => {
    await context.route("**/api/projects/*/designs/*/chat", async (route) => {
      await Bun.sleep(700);
      await route.fulfill({ json: [] });
    });
    await start(page).getByLabel("First prompt").fill("A page with a slow history");
    await start(page).getByRole("button", { name: "Start", exact: true }).click();
    await start(page).waitFor({ state: "detached" });
    await Bun.sleep(300);
    expect(turns).toHaveLength(0); // the stored chat is still on its way
    await page.getByText("I make the first screen.").waitFor();
    expect(await page.getByText("A page with a slow history").count()).toBeLessThanOrEqual(2); // the message, and maybe the title
    expect(turns).toHaveLength(1);
    expect(await page.locator(".chat").getByText("I make the first screen.").count()).toBe(1);
  });
}, 30_000);

test.skipIf(!hasBrowser)("a node link opens its design without the screen, and the sample opens from the screen once", async () => {
  await drive(async () => {}, async ({ page }) => {
    await page.locator(".frame-name").first().waitFor();
    expect(await start(page).count()).toBe(0);
  }, "/?project=sample&design=home");
  await drive(async () => {}, async ({ page, turns }) => {
    await start(page).getByRole("button", { name: "Open the sample" }).click();
    await start(page).waitFor({ state: "detached" });
    await page.locator(".frame-name").first().waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".frame-name").first().waitFor();
    expect(await start(page).count()).toBe(0);
    expect(turns).toHaveLength(0);
  });
}, 40_000);

test.skipIf(!hasBrowser)("the repo link is optional; a failed link keeps the screen, makes one project, and can go on without it", async () => {
  await drive(async () => {}, async ({ page, context, origin, turns }) => {
    let asked = 0;
    await context.route("**/api/github/status", (route) => { asked++; return route.fulfill({ json: { installed: true, loggedIn: true } }); });
    await context.route("**/api/github/repos", (route) => route.fulfill({ json: [{ name: "me/app", description: "The app", private: true, language: "TypeScript", updatedAt: "2026-11-01T00:00:00Z" }] }));
    let links = 0;
    await context.route("**/api/projects/*/repo", (route) => {
      links++;
      return links === 1 ? route.fulfill({ status: 500, json: { error: "The clone failed" } }) : route.fulfill({ json: { name: "me/app" } });
    });
    await start(page).waitFor();
    expect(asked).toBe(0); // no repo asked for: gh stays out of it
    await start(page).getByRole("button", { name: "Link the app's repo (optional)" }).click();
    await start(page).getByRole("button", { name: "Link", exact: true }).click();
    await start(page).getByText("me/app").waitFor();
    await start(page).getByLabel("First prompt").fill("A settings page");
    await start(page).getByRole("button", { name: "Start", exact: true }).click();
    await start(page).getByText("The clone failed").waitFor();
    expect(turns).toHaveLength(0);

    // Another try links again, in the same project.
    await start(page).getByRole("button", { name: "Start", exact: true }).click();
    await page.getByText("I make the first screen.").waitFor();
    expect(links).toBe(2);
    expect((await projectsOf(origin)).filter((p) => p.id.startsWith("a-settings-page")).map((p) => p.id)).toEqual(["a-settings-page"]);
  });
  await drive(async () => {}, async ({ page, context, origin, turns }) => {
    await context.route("**/api/github/status", (route) => route.fulfill({ json: { installed: true, loggedIn: true } }));
    await context.route("**/api/github/repos", (route) => route.fulfill({ json: [{ name: "me/app", description: "The app", private: true, language: "TypeScript", updatedAt: "2026-11-01T00:00:00Z" }] }));
    let links = 0;
    await context.route("**/api/projects/*/repo", (route) => { links++; return route.fulfill({ status: 500, json: { error: "The clone failed" } }); });
    await start(page).getByRole("button", { name: "Link the app's repo (optional)" }).click();
    await start(page).getByRole("button", { name: "Link", exact: true }).click();
    await start(page).getByLabel("First prompt").fill("A settings page");
    await start(page).getByRole("button", { name: "Start", exact: true }).click();
    await start(page).getByRole("button", { name: "Start without the repo" }).click();
    await page.getByText("I make the first screen.").waitFor();
    expect(links).toBe(1);
    expect(turns).toHaveLength(1);
    expect((await projectsOf(origin)).find((p) => p.id === "a-settings-page")?.repo ?? null).toBeNull();
  });
}, 40_000);
