import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle, bundleTokens, draftHandoff, HANDOFF_TEMPLATE, MAX_SCREENSHOTS, screenshotPlan, writeBundle } from "../src/handoff/bundle.ts";
import { REPORT_HEADER } from "../src/server/export.ts";
import { getHandoff, postBundle } from "../src/server/handoff.ts";
import { appendChat } from "../src/workspace/chat.ts";
import { addComment, updateComment } from "../src/workspace/comments.ts";
import { designSystemDir } from "../src/workspace/design-systems.ts";
import { writeLayout } from "../src/workspace/layout.ts";
import { designDir } from "../src/workspace/paths.ts";

let ws: string;
let dir: string;
const at = "2026-10-13T00:00:00.000Z";
const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** A renderer without a browser: each PNG names its page title, frame size and options. */
const calls: { html: string; frames: { width: number; height: number }[]; options: unknown }[] = [];
const fakeRender = async (html: string, frames: { width: number; height: number }[], options: unknown) => {
  calls.push({ html, frames, options });
  return frames.map((f) => Buffer.from(`png ${html.match(/<p[^>]*>([^<]*)/)?.[1]} ${f.width}x${f.height}`));
};

beforeEach(async () => {
  calls.length = 0;
  ws = await mkdtemp(join(tmpdir(), "doi-handoff-"));
  dir = designDir(ws, "shop", "home");
  await mkdir(join(dir, "img"), { recursive: true });
  await Bun.write(join(ws, "projects", "shop", "project.json"), JSON.stringify({ name: "The Shop", designSystem: null }));
  await Bun.write(
    join(dir, "index.html"),
    '<html><head><link rel="stylesheet" href="styles.css"></head><body><p data-oid="hero">Home</p><img src="img/a.png" data-oid="pic"></body></html>',
  );
  await Bun.write(join(dir, "about.html"), '<html><body><p data-oid="about">About</p></body></html>');
  await Bun.write(join(dir, "styles.css"), ":root { --accent: #c00; --gap: 16px; }\np { color: var(--accent); }\n");
  await Bun.write(join(dir, "img", "a.png"), new Uint8Array([1, 2, 3]));
});

describe("HANDOFF.md draft", () => {
  test("fills the template with the requests, pages, screenshots, tokens and open comments", async () => {
    await appendChat(ws, "shop", { role: "user", turn: "t1", design: "home", at, text: "A shop home\nwith a hero", target: null });
    await appendChat(ws, "shop", { role: "user", turn: "t2", design: "home", at, text: "Make it {{design}} red", target: "hero" });
    await appendChat(ws, "shop", { role: "user", turn: "t3", design: "other", at, text: "Not this design", target: null });
    await addComment(ws, "shop", "home", { oid: "hero", text: "Bigger `title`", version: null });
    await addComment(ws, "shop", "home", { oid: "gone", text: "Old element", version: null });
    const done = await addComment(ws, "shop", "home", { oid: "pic", text: "Done one", version: null });
    await updateComment(ws, "shop", "home", done.id, { status: "done" });

    const md = await draftHandoff(ws, "shop", "home");
    expect(md).toStartWith("# Handoff: home\n");
    expect(md).toContain('Implement the design "home" of the doi project "The Shop" in this repo.');
    expect(md).toContain("- A shop home with a hero\n- (element `hero`) Make it {{design}} red\n");
    expect(md).not.toContain("Not this design");
    expect(md).toContain("  - `design/index.html`\n  - `design/about.html`\n");
    expect(md).toContain("  - `screenshots/index-desktop.png`: `index.html` in the frame Desktop, 1440 × 900");
    expect(md).toContain("  - `screenshots/about-mobile.png`: `about.html` in the frame Mobile, 390 × 844");
    expect(md).toContain("`tokens.css`: the tokens (CSS custom properties) of the stylesheets of the design.");
    expect(md).toContain("- On `hero`: Bigger `title`\n- On `gone`: Old element (This element is not in the design now.)\n");
    expect(md).not.toContain("Done one");
    expect(md).not.toMatch(/\{\{(?!design\}\} red)\w+\}\}/);
    expect(HANDOFF_TEMPLATE.version).toBe("v0");
  });

  test("says when there are no requests, comments or tokens", async () => {
    await Bun.write(join(dir, "styles.css"), "p { color: red; }\n");
    const md = await draftHandoff(ws, "shop", "home");
    expect(md).toContain("- None. The chat has no requests for this design.");
    expect(md).toContain("## Open comments\n\nNone.\n");
    expect(md).toContain("There is no `tokens.css`: the design has no CSS custom properties.");
  });

  test("tokens come from the design system first", async () => {
    await mkdir(designSystemDir(ws, "brand"), { recursive: true });
    await Bun.write(join(designSystemDir(ws, "brand"), "tokens.css"), ":root { --ink: #111; /* c */ --ink: #222; }\n");
    await Bun.write(join(ws, "projects", "shop", "project.json"), JSON.stringify({ name: "The Shop", designSystem: "brand" }));
    expect(await bundleTokens(ws, "shop", "home")).toEqual({
      css: '/* The tokens of the design system "brand", from doi. */\n:root {\n  --ink: #111;\n}\n',
      from: 'the design system "brand"',
    });
  });

  test("without a project design system, tokens come from the design and the design system files it links", async () => {
    await mkdir(designSystemDir(ws, "brand"), { recursive: true });
    await Bun.write(join(designSystemDir(ws, "brand"), "tokens.css"), ":root { --ink: #111; }\n");
    await Bun.write(join(dir, "about.html"), '<html><head><link rel="stylesheet" href="/ds/brand/tokens.css"></head><body></body></html>');
    expect((await bundleTokens(ws, "shop", "home"))?.css).toContain("  --accent: #c00;\n  --gap: 16px;\n  --ink: #111;\n");
  });

  test("screenshot names are safe and unique per page and frame", () => {
    const frames = [{ id: "desktop", label: "Desktop", width: 1440, height: 900, x: 0, y: 0 }];
    expect(screenshotPlan(["index.html", "shop/cart page.html"], frames).map((s) => s.path)).toEqual([
      "screenshots/index-desktop.png",
      "screenshots/shop-cart-page-desktop.png",
    ]);
  });
});

describe("bundle", () => {
  test("has HANDOFF.md, the design with its data-oids, one full-page PNG per page and frame, and tokens.css", async () => {
    const bundle = await buildBundle(ws, "shop", "home", "# My handoff\n", fakeRender);
    const files = Object.fromEntries(bundle.files.map((f) => [f.path, text(f.data)]));
    expect(Object.keys(files).sort()).toEqual([
      "HANDOFF.md",
      "design/about.html",
      "design/img/a.png",
      "design/index.html",
      "design/styles.css",
      "screenshots/about-desktop.png",
      "screenshots/about-mobile.png",
      "screenshots/index-desktop.png",
      "screenshots/index-mobile.png",
      "tokens.css",
    ]);
    expect(files["HANDOFF.md"]).toBe("# My handoff\n");
    expect(files["design/index.html"]).toContain('data-oid="hero"');
    expect(files["screenshots/index-desktop.png"]).toBe("png Home 1440x900");
    expect(files["screenshots/about-mobile.png"]).toBe("png About 390x844");
    expect(files["tokens.css"]).toContain("  --accent: #c00;\n  --gap: 16px;\n");
    // One render per page, with all frames, the whole page and scale 1; the page has its CSS inline.
    expect(calls.map((c) => c.options)).toEqual([{ scale: 1, fullPage: true }, { scale: 1, fullPage: true }]);
    expect(calls[0]!.html).toContain("--accent: #c00");
    expect(bundle).toMatchObject({ missing: [], warnings: [] });
  });

  test("limits the screenshots and reports it", async () => {
    const frames = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, label: `F${i}`, width: 400, height: 300, x: i * 500, y: 0 }));
    await writeLayout(ws, "shop", "home", frames);
    await Bun.write(join(dir, "c.html"), "<p>C</p>");
    const bundle = await buildBundle(ws, "shop", "home", "x", fakeRender);
    expect(bundle.files.filter((f) => f.path.startsWith("screenshots/")).length).toBe(MAX_SCREENSHOTS);
    expect(bundle.warnings).toEqual([`The bundle has the first ${MAX_SCREENSHOTS} of 36 screenshots.`]);
  });

  test("needs a HANDOFF.md text", async () => {
    for (const bad of [undefined, "", "  ", 3, "x".repeat(100_001)]) {
      await expect(buildBundle(ws, "shop", "home", bad, fakeRender)).rejects.toThrow("markdown must be");
    }
  });

  test("writeBundle writes every file into the folder", async () => {
    const out = await mkdtemp(join(tmpdir(), "doi-bundle-"));
    await writeBundle(await buildBundle(ws, "shop", "home", "# H\n", fakeRender), out);
    expect((await readdir(out, { recursive: true })).sort()).toContain("design/img/a.png");
    expect(await Bun.file(join(out, "HANDOFF.md")).text()).toBe("# H\n");
  });
});

describe("handoff routes", () => {
  const params = { project: "shop", design: "home" };
  const post = (body: unknown) =>
    new Request("http://127.0.0.1/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("GET gives the draft", async () => {
    const res = await getHandoff(ws, params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template).toBe("v0");
    expect(body.markdown).toStartWith("# Handoff: home");
  });

  test("POST gives a ZIP with one folder and the user's HANDOFF.md", async () => {
    const res = await postBundle(ws, post({ markdown: "# Edited\n" }), params, fakeRender);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="home-handoff.zip"');
    expect(JSON.parse(decodeURIComponent(res.headers.get(REPORT_HEADER)!))).toEqual({ missing: [], warnings: [] });
    const zipPath = join(await mkdtemp(join(tmpdir(), "doi-zip-")), "b.zip");
    await Bun.write(zipPath, await res.arrayBuffer());
    const list = await Bun.$`unzip -Z1 ${zipPath}`.text();
    expect(list).toContain("home-handoff/HANDOFF.md\n");
    expect(list).toContain("home-handoff/screenshots/index-desktop.png\n");
    expect(await Bun.$`unzip -p ${zipPath} home-handoff/HANDOFF.md`.text()).toBe("# Edited\n");
  });

  test("bad names, a missing design and a bad body", async () => {
    expect((await getHandoff(ws, { project: "shop", design: "../x" })).status).toBe(400);
    expect((await getHandoff(ws, { project: "shop", design: "none" })).status).toBe(404);
    expect((await postBundle(ws, post({}), params, fakeRender)).status).toBe(400);
    expect((await postBundle(ws, new Request("http://127.0.0.1/x", { method: "POST", body: "nope" }), params, fakeRender)).status).toBe(400);
  });
});
