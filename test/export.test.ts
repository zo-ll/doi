import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportFolder, exportPage, resolveRef } from "../src/export/html.ts";
import { zip } from "../src/export/zip.ts";
import { getExport, REPORT_HEADER } from "../src/server/export.ts";
import { exportUrl, fileNameOf, parseReport } from "../src/web/export.ts";
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
    expect((await get("?format=pdf")).status).toBe(400);
    expect((await get("?oids=maybe")).status).toBe(400);
    expect((await get("", { project: "p", design: "Bad Name" })).status).toBe(400);
    expect((await get("", { project: "p", design: "none" })).status).toBe(404);
    expect((await get("?format=page&page=nope.html")).status).toBe(404);
  });
});

describe("export UI helpers", () => {
  test("builds the URL and reads the response headers", () => {
    expect(exportUrl("p", "d", "page", true)).toBe("/api/projects/p/designs/d/export?format=page&oids=strip");
    expect(exportUrl("p", "d", "folder", false)).toBe("/api/projects/p/designs/d/export?format=folder&oids=keep");
    expect(fileNameOf('attachment; filename="d.zip"', "x")).toBe("d.zip");
    expect(fileNameOf(null, "x.html")).toBe("x.html");
    const header = encodeURIComponent(JSON.stringify({ missing: ["ä.png"], warnings: ["w", 3] }));
    expect(parseReport(header)).toEqual({ missing: ["ä.png"], warnings: ["w"] });
    expect(parseReport(null)).toEqual({ missing: [], warnings: [] });
    expect(parseReport("%E0%A4%A")).toEqual({ missing: [], warnings: [] });
  });
});
