import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkDesignSystem } from "../src/generation/ds-link.ts";
import {
  activeDesignSystem,
  designSystemDir,
  formatDesignSystem,
  listDesignSystems,
  loadDesignSystem,
  parseTokens,
  previewPage,
  stylesOf,
} from "../src/workspace/design-systems.ts";
import { getDesignSystem, putProjectDesignSystem } from "../src/server/design-systems.ts";
import { projectFile } from "../src/workspace/project-file.ts";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "doi-ds-"));
  const dir = designSystemDir(ws, "brand");
  await mkdir(join(dir, "fonts"), { recursive: true });
  await mkdir(join(dir, "screenshots"), { recursive: true });
  await Bun.write(join(dir, "tokens.css"), ":root { --color-primary: #0a7; --space-2: 8px; }\n");
  await Bun.write(join(dir, "components.html"), '<button class="btn btn-primary">Buy</button>\n');
  await Bun.write(join(dir, "rules.md"), "- One primary button per screen.\n");
  await Bun.write(join(dir, "fonts", "Brand-Regular.woff2"), "x");
  await Bun.write(join(dir, "fonts", ".DS_Store"), "x");
  await Bun.write(join(dir, "screenshots", "home.png"), "x");
  // A design system with only tokens.
  await mkdir(designSystemDir(ws, "plain"), { recursive: true });
  await Bun.write(join(designSystemDir(ws, "plain"), "tokens.css"), ":root { --x: 1px; }");
  await mkdir(join(ws, "projects", "p"), { recursive: true });
});

describe("design system loader", () => {
  test("loads all parts; a missing part is null or empty, not an error", async () => {
    expect(await loadDesignSystem(ws, "brand")).toEqual({
      name: "brand",
      tokens: ":root { --color-primary: #0a7; --space-2: 8px; }\n",
      components: '<button class="btn btn-primary">Buy</button>\n',
      componentStyles: null,
      rules: "- One primary button per screen.\n",
      fonts: ["Brand-Regular.woff2"],
      screenshots: ["home.png"],
    });
    expect(await loadDesignSystem(ws, "plain")).toEqual({
      name: "plain", tokens: ":root { --x: 1px; }", components: null, componentStyles: null, rules: null, fonts: [], screenshots: [],
    });
    expect(await loadDesignSystem(ws, "none")).toBeNull();
    await expect(loadDesignSystem(ws, "../x")).rejects.toThrow("Invalid design system name");
    expect(await listDesignSystems(ws)).toEqual(["brand", "plain"]);
  });

  test("the project's choice comes from project.json; a bad or missing choice is none", async () => {
    expect(await activeDesignSystem(ws, "p")).toBeNull();
    await Bun.write(projectFile(ws, "p"), JSON.stringify({ name: "P", designSystem: "brand" }));
    expect((await activeDesignSystem(ws, "p"))?.name).toBe("brand");
    await Bun.write(projectFile(ws, "p"), JSON.stringify({ name: "P", designSystem: "gone" }));
    expect(await activeDesignSystem(ws, "p")).toBeNull();
    await Bun.write(projectFile(ws, "p"), JSON.stringify({ name: "P", designSystem: "../etc" }));
    expect(await activeDesignSystem(ws, "p")).toBeNull();
  });

  test("the prompt text says to link the tokens, and has each part that exists", async () => {
    const text = formatDesignSystem((await loadDesignSystem(ws, "brand"))!);
    expect(text).toStartWith("# Design system: brand");
    expect(text).toContain('<link rel="stylesheet" href="/ds/brand/tokens.css">');
    expect(text).toContain("Do not copy their values into styles.css");
    expect(text).toContain("--color-primary: #0a7");
    expect(text).toContain("/ds/brand/fonts/Brand-Regular.woff2");
    expect(text).toContain('<button class="btn btn-primary">Buy</button>');
    expect(text).toContain("- One primary button per screen.");
    expect(text).toContain("home.png");

    const plain = formatDesignSystem((await loadDesignSystem(ws, "plain"))!);
    expect(plain).not.toContain("## Components");
    expect(plain).not.toContain("## Rules");
    expect(plain).not.toContain("## Fonts");
    const empty = formatDesignSystem({ name: "e", tokens: null, components: null, componentStyles: null, rules: null, fonts: [], screenshots: [] });
    expect(empty).toBe("# Design system: e");
  });
});

describe("design system links", () => {
  const page = (head: string) => `<!doctype html>\n<html><head>\n  <meta charset="utf-8">\n${head}</head><body><p>x</p></body></html>\n`;
  const files = (html: string) => [{ path: "index.html", content: html }, { path: "styles.css", content: "p{}" }];
  const both = { name: "brand", tokens: ":root{}", componentStyles: ".btn{}" };
  const own = '  <link rel="stylesheet" href="styles.css">\n';
  const tokens = '<link rel="stylesheet" href="/ds/brand/tokens.css">';
  const comps = '<link rel="stylesheet" href="/ds/brand/components.css">';

  test("missing links go before the page's own stylesheet, tokens first", async () => {
    const out = await linkDesignSystem(files(page(own)), both);
    expect(out).toEqual([{ path: "index.html", content: page(`  ${tokens}\n  ${comps}\n${own}`) }]);
  });

  test("without an own stylesheet they go at the end of <head>; only the parts that exist", async () => {
    const out = await linkDesignSystem(files(page("")), { ...both, componentStyles: null });
    expect(out[0]!.content).toBe(page(`  ${tokens}\n`));
    expect(await linkDesignSystem(files(page("")), { name: "x", tokens: null, componentStyles: null })).toEqual([]);
  });

  test("a page with the links is not changed; links to another system move to this one; one missing link is added", async () => {
    const linked = page(`  ${tokens}\n  ${comps}\n${own}`);
    expect(await linkDesignSystem(files(linked), both)).toEqual([]);
    const other = await linkDesignSystem(files(linked.replaceAll("/ds/brand/", "/ds/old/")), both);
    expect(other[0]!.content).toBe(linked);
    const onlyTokens = await linkDesignSystem(files(page(`  ${tokens}\n${own}`)), both);
    expect(onlyTokens[0]!.content).toBe(page(`  ${tokens}\n  ${comps}\n${own}`));
  });

  test("a fragment without <head> and non-HTML files are left as they are", async () => {
    expect(await linkDesignSystem([{ path: "part.html", content: "<p>x</p>" }, { path: "a.css", content: "x" }], both)).toEqual([]);
  });
});

test("component styles come from components.css, or else from the <style> blocks of components.html", async () => {
  expect(stylesOf('<button class="b">x</button>\n<style>\n.b { color: red; }\n</style><style media="x">.c{}</style>')).toBe(".b { color: red; }\n\n.c{}\n");
  expect(stylesOf("<p>no styles</p>")).toBeNull();
  expect(stylesOf(null)).toBeNull();
  await Bun.write(join(designSystemDir(ws, "brand"), "components.html"), "<button class=b>x</button><style>.b{}</style>");
  expect((await loadDesignSystem(ws, "brand"))!.componentStyles).toBe(".b{}\n");
  await Bun.write(join(designSystemDir(ws, "brand"), "components.css"), ".b { color: blue; }");
  expect((await loadDesignSystem(ws, "brand"))!.componentStyles).toBe(".b { color: blue; }");
  const text = formatDesignSystem((await loadDesignSystem(ws, "brand"))!);
  expect(text).toContain('<link rel="stylesheet" href="/ds/brand/tokens.css">\n<link rel="stylesheet" href="/ds/brand/components.css">');
  expect(text).toContain("do not style them again in styles.css");
});

describe("design system view", () => {
  test("tokens are grouped, and var() references are resolved for the preview", () => {
    const tokens = parseTokens(`
      /* --commented: 1px; */
      :root {
        --color-primary: #6b21a8;
        --accent: var(--color-primary);
        --surface: rgb(255 255 255);
        --font-sans: Georgia, serif;
        --text-lg: 18px;
        --space-4: 16px;
        --radius-md: 10px;
        --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.1);
        --z-modal: 50;
        --missing: var(--nope, 4px);
        --color-primary: #000;
      }
      @media (prefers-color-scheme: dark) { :root { --surface: #111; } }`);
    expect(tokens.map((t) => [t.name, t.group, t.resolved])).toEqual([
      ["--color-primary", "color", "#6b21a8"],
      ["--accent", "color", "#6b21a8"],
      ["--surface", "color", "rgb(255 255 255)"],
      ["--font-sans", "type", "Georgia, serif"],
      ["--text-lg", "type", "18px"],
      ["--space-4", "space", "16px"],
      ["--radius-md", "radius", "10px"],
      ["--shadow-sm", "shadow", "0 1px 2px rgb(0 0 0 / 0.1)"],
      ["--z-modal", "other", "50"],
      ["--missing", "other", "4px"],
    ]);
    expect(tokens[1]!.value).toBe("var(--color-primary)");
    // A loop does not hang.
    expect(parseTokens(":root { --a: var(--b); --b: var(--a); }")).toHaveLength(2);
  });

  test("the preview page links the stylesheets and shows the markup without <style>", async () => {
    await Bun.write(join(designSystemDir(ws, "brand"), "components.html"), '<button class="b">Go</button>\n<style>.b{}</style>');
    const html = previewPage((await loadDesignSystem(ws, "brand"))!);
    expect(html).toContain('<link rel="stylesheet" href="/ds/brand/tokens.css">');
    expect(html).toContain('<link rel="stylesheet" href="/ds/brand/components.css">');
    expect(html).toContain('<body>\n<button class="b">Go</button>\n</body>');
    expect(html).not.toContain(".b{}");
    expect(previewPage((await loadDesignSystem(ws, "plain"))!)).toContain("This design system has no components.html.");
  });

  test("GET gives tokens, files and rules; PUT selects a design system for a project and commits", async () => {
    const view = await (await getDesignSystem(ws, "brand")).json();
    expect(view).toMatchObject({
      name: "brand",
      dir: designSystemDir(ws, "brand"),
      files: ["components.html", "fonts/Brand-Regular.woff2", "rules.md", "screenshots/home.png", "tokens.css"],
      fonts: ["Brand-Regular.woff2"],
      rules: "- One primary button per screen.\n",
      hasComponents: true,
    });
    expect(view.tokens.map((t: { name: string }) => t.name)).toEqual(["--color-primary", "--space-2"]);
    expect((await getDesignSystem(ws, "nope")).status).toBe(404);
    expect((await getDesignSystem(ws, "../x")).status).toBe(400);

    await Bun.write(projectFile(ws, "p"), JSON.stringify({ name: "P", designSystem: null }));
    const commits: string[] = [];
    const deps = { config: { workspace: ws } as any, commit: async (_: string[], m: string) => (commits.push(m), "c") };
    const put = (body: unknown, project = "p") =>
      putProjectDesignSystem(deps, new Request("http://x/", { method: "PUT", body: JSON.stringify(body) }), { project });
    expect(await (await put({ name: "brand" })).json()).toEqual({ name: "brand", commit: "c" });
    expect((await activeDesignSystem(ws, "p"))?.name).toBe("brand");
    expect((await Bun.file(projectFile(ws, "p")).json()).name).toBe("P");
    expect(await (await put({ name: null })).json()).toEqual({ name: null, commit: "c" });
    expect(await activeDesignSystem(ws, "p")).toBeNull();
    expect(commits).toEqual(["Use design system brand", "Use no design system"]);
    expect((await put({ name: "nope" })).status).toBe(404);
    expect((await put({ name: "Bad Name" })).status).toBe(400);
    expect((await put({ name: "brand" }, "none")).status).toBe(404);
  });
});
