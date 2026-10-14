import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportFolder, exportPage, hoistImports, resolveRef, wrapImport } from "../src/export/html.ts";
import { zip } from "../src/export/zip.ts";
import { getExport, REPORT_HEADER } from "../src/server/export.ts";
import { bundleRequest, exportUrl, fallbackName, fileNameOf, parseReport, type ExportChoice } from "../src/web/export.ts";
import { designSystemDir } from "../src/workspace/design-systems.ts";
import { designDir } from "../src/workspace/paths.ts";

let ws: string;
let dir: string;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const FONT = new Uint8Array([119, 79, 70, 50, 0, 1]);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

const INDEX = `<!doctype html>
<html>
<head>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
  <link rel="stylesheet" href="/ds/brand/tokens.css">
  <link rel="stylesheet" href="/ds/brand/components.css">
  <link rel="stylesheet" href="styles.css" media="screen">
  <link rel="icon" href="img/dot.png">
  <style>.hero { background: url("img/dot.png"); }</style>
</head>
<body>
  <main data-oid="page">
    <section class="hero" data-oid="hero" style="background-image: url(img/dot.png)">
      <img src="img/dot.png" srcset="img/dot.png 1x, img/dot.png?v=2 2x" alt="" data-oid="hero-image">
      <a href="about.html" data-oid="about-link">About</a>
      <a href="#top">Top</a>
      <img src="img/gone.png" alt="">
    </section>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "doi-export-"));
  dir = designDir(ws, "p", "d");
  await mkdir(join(dir, "img"), { recursive: true });
  await Bun.write(join(dir, "index.html"), INDEX);
  await Bun.write(join(dir, "about.html"), '<html><head><link rel="stylesheet" href="/ds/brand/tokens.css"></head><body><p data-oid="x">About</p></body></html>');
  await Bun.write(join(dir, "styles.css"), '@import "parts.css";\nbody { background: url(img/dot.png) }\n');
  await Bun.write(join(dir, "parts.css"), ".part { color: var(--ink); }\n");
  await Bun.write(join(dir, "app.js"), 'console.log("</script>");\n');
  await Bun.write(join(dir, "img", "dot.png"), PNG);
  await Bun.write(join(dir, ".comments.json"), "[]\n");
  const ds = designSystemDir(ws, "brand");
  await mkdir(join(ds, "fonts"), { recursive: true });
  await Bun.write(join(ds, "tokens.css"), '@font-face { font-family: Brand; src: url("fonts/brand.woff2") format("woff2"); }\n:root { --ink: #111; }\n');
  await Bun.write(join(ds, "components.html"), "<style>.btn { color: var(--ink); }</style><button class=\"btn\">B</button>");
  await Bun.write(join(ds, "fonts", "brand.woff2"), FONT);
  await Bun.write(join(ds, "rules.md"), "Use the tokens.\n");
});

describe("resolveRef", () => {
  test("maps local files and /ds/ links, and skips other links", () => {
    expect(resolveRef("img/a.png?v=1#x", "pages/index.html")).toEqual({ path: "pages/img/a.png", suffix: "?v=1#x", dsAbsolute: false });
    expect(resolveRef("/ds/brand/tokens.css", "pages/index.html")).toEqual({ path: "design-system/brand/tokens.css", suffix: "", dsAbsolute: true });
    expect(resolveRef("fonts/a.woff2", "design-system/brand/tokens.css")?.path).toBe("design-system/brand/fonts/a.woff2");
    expect(resolveRef("img%20one.png", "index.html")?.path).toBe("img one.png");
    // An encoded "/" is part of a name; it cannot make new folders.
    expect(resolveRef("a%2fb%2f..%2f..%2fsecret.txt", "index.html")).toBeNull();
    for (const ref of ["https://x.test/a.png", "//x.test/a", "data:image/png;base64,AA", "#top", "/api/projects", "mailto:a@b.c", "", "dir/"]) {
      expect(resolveRef(ref, "index.html")).toBeNull();
    }
  });
});

describe("exportFolder", () => {
  test("copies the design and the linked design system files, with relative links", async () => {
    const result = await exportFolder(ws, "p", "d", { stripOids: false });
    const files = new Map(result.files.map((f) => [f.path, f.data]));
    expect([...files.keys()].sort()).toEqual([
      "about.html",
      "app.js",
      "design-system/brand/components.css",
      "design-system/brand/fonts/brand.woff2",
      "design-system/brand/tokens.css",
      "img/dot.png",
      "index.html",
      "parts.css",
      "styles.css",
    ]);
    const index = text(files.get("index.html")!);
    expect(index).toContain('href="design-system/brand/tokens.css"');
    expect(index).toContain('href="design-system/brand/components.css"');
    expect(index).toContain('href="https://fonts.googleapis.com/css2?family=Inter"');
    expect(index).not.toContain("/ds/");
    expect(index).toContain('data-oid="hero"');
    expect(text(files.get("design-system/brand/components.css")!)).toContain(".btn { color: var(--ink); }");
    expect(files.get("design-system/brand/fonts/brand.woff2")).toEqual(FONT);
    expect(files.get("img/dot.png")).toEqual(PNG);
    expect(result.missing).toEqual(["img/gone.png"]);
    expect(result.warnings).toEqual([]);
  });

  test("makes /ds/ links relative to a page in a subfolder", async () => {
    await mkdir(join(dir, "pages"));
    await Bun.write(join(dir, "pages", "two.html"), '<html><head><link rel="stylesheet" href="/ds/brand/tokens.css"></head><body></body></html>');
    const result = await exportFolder(ws, "p", "d", { stripOids: false });
    const two = text(result.files.find((f) => f.path === "pages/two.html")!.data);
    expect(two).toContain('href="../design-system/brand/tokens.css"');
  });

  test("removes data-oid attributes on request and warns when CSS uses them", async () => {
    const plain = await exportFolder(ws, "p", "d", { stripOids: true });
    const index = text(plain.files.find((f) => f.path === "index.html")!.data);
    expect(index).not.toContain("data-oid");
    expect(index).toContain('class="hero"');
    expect(plain.warnings).toEqual([]);

    await Bun.write(join(dir, "parts.css"), '[data-oid="hero"] { color: red; }\n');
    const warned = await exportFolder(ws, "p", "d", { stripOids: true });
    expect(warned.warnings[0]).toContain("data-oid");
  });

  test("refuses a design with its own design-system folder", async () => {
    await mkdir(join(dir, "design-system"));
    await Bun.write(join(dir, "design-system", "x.css"), "");
    await expect(exportFolder(ws, "p", "d", { stripOids: false })).rejects.toThrow("design-system");
  });

  test("a design without a design system has no design-system folder", async () => {
    await Bun.write(join(dir, "index.html"), '<html><head><link rel="stylesheet" href="styles.css"></head><body></body></html>');
    await Bun.write(join(dir, "about.html"), "<p>a</p>");
    const result = await exportFolder(ws, "p", "d", { stripOids: false });
    expect(result.files.some((f) => f.path.startsWith("design-system/"))).toBe(false);
  });
});

describe("wrapImport", () => {
  test("wraps the CSS in the conditions of the @import", () => {
    expect(wrapImport("a{}", "")).toBe("a{}");
    expect(wrapImport("a{}", " print ")).toBe("@media print {\na{}\n}");
    expect(wrapImport("a{}", "layer")).toBe("@layer {\na{}\n}");
    expect(wrapImport("a{}", "layer(x.y)")).toBe("@layer x.y {\na{}\n}");
    expect(wrapImport("a{}", "supports(display: grid)")).toBe("@supports (display: grid) {\na{}\n}");
    expect(wrapImport("a{}", "supports(selector(a:has(b)))")).toBe("@supports selector(a:has(b)) {\na{}\n}");
    expect(wrapImport("a{}", "supports((a: b) and (c: d))")).toBe("@supports (a: b) and (c: d) {\na{}\n}");
    expect(wrapImport("a{}", "layered-screen")).toBe("@media layered-screen {\na{}\n}");
  });

  test("hoistImports moves the imports that stay to the start", () => {
    expect(hoistImports('.a{}\n@import url("https://x.test/a.css") print;\n.b{}')).toBe('@import url("https://x.test/a.css") print;\n.a{}\n\n.b{}');
    expect(hoistImports(".a{}")).toBe(".a{}");
    const commented = '.a{}\n/* legacy: @import "reset.css"; */\n';
    expect(hoistImports(commented)).toBe(commented);
    // "/*" in a string is not a comment, and "*/" in a comment ends it.
    expect(hoistImports('.a{content:"/*"}\n@import url("https://x.test/a.css");\n')).toBe('@import url("https://x.test/a.css");\n.a{content:"/*"}\n\n');
    expect(hoistImports("/* ' */\n@import url(\"https://x.test/a.css\");\n")).toBe('@import url("https://x.test/a.css");\n/* \' */\n\n');
  });

  test("a commented @import is not inlined", async () => {
    await Bun.write(join(dir, "styles.css"), '/* @import "parts.css"; */\nbody {}\n');
    const { html } = await exportPage(ws, "p", "d", { stripOids: false });
    expect(html).toContain('/* @import "parts.css"; */');
    expect(html).not.toContain(".part {");
  });
});

describe("exportPage", () => {
  test("inlines stylesheets, imports, scripts, images and fonts", async () => {
    const { html, missing, warnings } = await exportPage(ws, "p", "d", { stripOids: false });
    expect(html).not.toMatch(/href="(\/ds\/|styles\.css|img\/)/);
    expect(html).not.toMatch(/src="(app\.js|img\/dot)/);
    expect(html).toContain(":root { --ink: #111; }");
    expect(html).toContain(".btn { color: var(--ink); }");
    expect(html).toContain(".part { color: var(--ink); }");
    expect(html).toContain('<style media="screen">');
    expect(html).toContain(`url("data:font/woff2;base64,${Buffer.from(FONT).toString("base64")}")`);
    const png = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
    expect(html).toContain(`<img src="${png}" srcset="${png} 1x, ${png} 2x"`);
    expect(html).toContain(`<link rel="icon" href="${png}">`);
    expect(html).toContain(`.hero { background: url("${png}"); }`);
    expect(html).toContain("background-image: url(&quot;" + png + "&quot;)");
    // The script's own "</script>" cannot close the inline element.
    expect(html).toContain('console.log("<\\/script>");');
    expect(html).toContain('href="https://fonts.googleapis.com/css2?family=Inter"');
    expect(html).toContain('href="#top"');
    expect(missing).toEqual(["img/gone.png"]);
    expect(warnings).toEqual(["Links to other pages of the design do not work in a single file."]);
  });

  test("exports another page and strips oids", async () => {
    const { html } = await exportPage(ws, "p", "d", { stripOids: true, page: "about.html" });
    expect(html).toContain(":root { --ink: #111; }");
    expect(html).not.toContain("data-oid");
    await expect(exportPage(ws, "p", "d", { stripOids: false, page: "app.js" })).rejects.toThrow("no page");
    await expect(exportPage(ws, "p", "d", { stripOids: false, page: ".comments.json" })).rejects.toThrow("no page");
  });

  test("keeps the layer, supports and media conditions of an inlined @import", async () => {
    await Bun.write(
      join(dir, "styles.css"),
      '@import "parts.css" layer(base) supports(display: grid) screen;\n@import url("https://fonts.googleapis.com/css2?family=Inter");\nbody {}\n',
    );
    const { html } = await exportPage(ws, "p", "d", { stripOids: false });
    const sheet = html.slice(html.indexOf('<style media="screen">'));
    // The import of another site stays first, so the browser still loads it.
    expect(sheet).toMatch(/^<style media="screen">\n@import url\("https:\/\/fonts\.googleapis\.com/);
    expect(sheet).toContain("@media screen {\n@supports (display: grid) {\n@layer base {\n.part { color: var(--ink); }");
  });

  test("an @import cycle stops", async () => {
    await Bun.write(join(dir, "parts.css"), '@import "styles.css";\n.part {}\n');
    const { html } = await exportPage(ws, "p", "d", { stripOids: false });
    expect(html).toContain(".part {}");
  });
});

describe("zip", () => {
  test("makes an archive that unzip reads", async () => {
    const big = new TextEncoder().encode("a".repeat(5000));
    const archive = zip([
      { path: "d/index.html", data: new TextEncoder().encode("<p>é</p>") },
      { path: "d/big.txt", data: big },
      { path: "d/img/dot.png", data: PNG },
    ]);
    expect(archive.length).toBeLessThan(5000);
    const out = await mkdtemp(join(tmpdir(), "doi-zip-"));
    await Bun.write(join(out, "a.zip"), archive);
    const check = Bun.spawnSync(["unzip", "-t", join(out, "a.zip")]);
    expect(check.exitCode).toBe(0);
    expect(Bun.spawnSync(["unzip", "-p", join(out, "a.zip"), "d/index.html"]).stdout.toString()).toBe("<p>é</p>");
    expect(Bun.spawnSync(["unzip", "-p", join(out, "a.zip"), "d/big.txt"]).stdout.toString()).toBe("a".repeat(5000));
    expect(new Uint8Array(Bun.spawnSync(["unzip", "-p", join(out, "a.zip"), "d/img/dot.png"]).stdout)).toEqual(PNG);
  });
});

describe("GET …/export", () => {
  const get = (query: string, params = { project: "p", design: "d" }) =>
    getExport(ws, new Request(`http://127.0.0.1/api/projects/p/designs/d/export${query}`), params);

  test("gives a ZIP download of the folder", async () => {
    const res = await get("?format=folder");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="d.zip"');
    const report = JSON.parse(decodeURIComponent(res.headers.get(REPORT_HEADER)!));
    expect(report).toEqual({ missing: ["img/gone.png"], warnings: [] });
    const out = await mkdtemp(join(tmpdir(), "doi-zip-"));
    await Bun.write(join(out, "d.zip"), await res.arrayBuffer());
    const list = Bun.spawnSync(["unzip", "-Z1", join(out, "d.zip")]).stdout.toString();
    expect(list).toContain("d/index.html");
    expect(list).toContain("d/design-system/brand/tokens.css");
  });

  test("gives one HTML file", async () => {
    const res = await get("?format=page&oids=strip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="d.html"');
    expect(await res.text()).not.toContain("data-oid");
    const about = await get("?format=page&page=about.html");
    expect(about.headers.get("content-disposition")).toBe('attachment; filename="d-about.html"');
  });

  test("checks the query and the design", async () => {
    expect((await get("?format=gif")).status).toBe(400);
    expect((await get("?oids=maybe")).status).toBe(400);
    expect((await get("", { project: "p", design: "Bad Name" })).status).toBe(400);
    expect((await get("", { project: "p", design: "none" })).status).toBe(404);
    expect((await get("?format=page&page=nope.html")).status).toBe(404);
  });
});

describe("GET …/export as PNG and PDF", () => {
  const calls: { kind: string; frames: { width: number; height: number }[]; options?: unknown; html: string }[] = [];
  const fake = {
    renderPngs: async (html: string, frames: { width: number; height: number }[], options: unknown) => {
      calls.push({ kind: "png", frames, options, html });
      return frames.map((_, i) => Buffer.from(`png${i}`));
    },
    renderPdf: async (html: string, frame: { width: number; height: number }) => {
      calls.push({ kind: "pdf", frames: [frame], html });
      return Buffer.from("%PDF-");
    },
  };
  const get = (query: string) =>
    getExport(ws, new Request(`http://127.0.0.1/api/projects/p/designs/d/export${query}`), { project: "p", design: "d" }, fake);

  test("renders one frame, all frames as a ZIP, or a PDF of the first frame", async () => {
    calls.length = 0;
    const one = await get("?format=png&frame=mobile&scale=1&full=1");
    expect(one.headers.get("content-type")).toBe("image/png");
    expect(one.headers.get("content-disposition")).toBe('attachment; filename="d-mobile.png"');
    expect(await one.text()).toBe("png0");
    expect(calls[0]!.frames).toEqual([expect.objectContaining({ id: "mobile", width: 390, height: 844 })]);
    expect(calls[0]!.options).toEqual({ scale: 1, fullPage: true });
    // The renderer gets the self-contained page.
    expect(calls[0]!.html).toContain(":root { --ink: #111; }");

    const all = await get("?format=png");
    expect(all.headers.get("content-disposition")).toBe('attachment; filename="d-png.zip"');
    expect(calls[1]!.frames.map((f) => f.width)).toEqual([1440, 390]);
    expect(calls[1]!.options).toEqual({ scale: 2, fullPage: false });
    const out = await mkdtemp(join(tmpdir(), "doi-zip-"));
    await Bun.write(join(out, "p.zip"), await all.arrayBuffer());
    expect(Bun.spawnSync(["unzip", "-Z1", join(out, "p.zip")]).stdout.toString().trim().split("\n")).toEqual(["d-desktop.png", "d-mobile.png"]);

    const pdf = await get("?format=pdf");
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe('attachment; filename="d-desktop.pdf"');
    expect(calls[2]!.frames).toEqual([expect.objectContaining({ id: "desktop" })]);
  });

  test("checks frame, scale and full", async () => {
    expect((await get("?format=png&frame=watch")).status).toBe(404);
    expect((await get("?format=pdf&frame=all")).status).toBe(404);
    expect((await get("?format=png&scale=3")).status).toBe(400);
    expect((await get("?format=png&full=yes")).status).toBe(400);
  });
});

describe("export UI helpers", () => {
  test("builds the URL and reads the response headers", () => {
    const choice: ExportChoice = { format: "page", stripOids: true, frame: "all", scale: 2, fullPage: false };
    expect(exportUrl("p", "d", choice)).toBe("/api/projects/p/designs/d/export?format=page&oids=strip");
    expect(exportUrl("p", "d", { ...choice, format: "folder", stripOids: false })).toBe("/api/projects/p/designs/d/export?format=folder&oids=keep");
    expect(exportUrl("p", "d", { ...choice, format: "png", fullPage: true })).toBe("/api/projects/p/designs/d/export?format=png&frame=all&scale=2&full=1");
    expect(exportUrl("p", "d", { ...choice, format: "pdf", frame: "mobile" })).toBe("/api/projects/p/designs/d/export?format=pdf&frame=mobile");
    expect(fallbackName("d", { ...choice, format: "png" })).toBe("d-png.zip");
    expect(fallbackName("d", { ...choice, format: "png", frame: "mobile" })).toBe("d-mobile.png");
    expect(fallbackName("d", { ...choice, format: "pdf", frame: "desktop" })).toBe("d-desktop.pdf");
    expect(fileNameOf('attachment; filename="d.zip"', "x")).toBe("d.zip");
    expect(fileNameOf(null, "x.html")).toBe("x.html");
    const header = encodeURIComponent(JSON.stringify({ missing: ["ä.png"], warnings: ["w", 3] }));
    expect(parseReport(header)).toEqual({ missing: ["ä.png"], warnings: ["w"] });
    expect(parseReport(null)).toEqual({ missing: [], warnings: [] });
    expect(parseReport("%E0%A4%A")).toEqual({ missing: [], warnings: [] });
  });
});

describe("bundle request", () => {
  test("posts the user's HANDOFF.md as JSON to the bundle route", () => {
    const { url, init } = bundleRequest("shop", "home", "# Handoff\n\nUse `{{x}}`.");
    expect(url).toBe("/api/projects/shop/designs/home/handoff/bundle");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ markdown: "# Handoff\n\nUse `{{x}}`." });
  });
});
