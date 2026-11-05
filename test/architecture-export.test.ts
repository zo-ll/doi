import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { parseConfig } from "../src/config.ts";
import { startServer } from "../src/server/app.ts";
import { createDiagram, diagramSchema } from "../src/architecture/schema.ts";
import { createNode } from "../src/architecture/nodes.ts";
import { createEdge } from "../src/architecture/edges.ts";
import { diagramSvg } from "../src/architecture/svg.ts";
import { imageName, postArchitectureExport } from "../src/server/architecture-export.ts";
import { ExportError } from "../src/export/html.ts";

const hasBrowser = await chromium.launch().then(browser => browser.close().then(() => true), () => false);
test.if(!!process.env.CI)("CI has Chromium for UML image export", () => expect(hasBrowser).toBe(true));

/** Width, height and the first pixel (RGBA) of a PNG. The first pixel is raw for every filter type. */
function png(bytes: Uint8Array): { width: number; height: number; first: number[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const width = view.getUint32(16), height = view.getUint32(20);
  expect(bytes[24]).toBe(8);
  const chunks: Uint8Array[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = view.getUint32(at), type = new TextDecoder().decode(bytes.slice(at + 4, at + 8));
    if (type === "IDAT") chunks.push(bytes.slice(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const channels = bytes[25] === 6 ? 4 : 3;
  return { width, height, first: [...raw.slice(1, 1 + channels)] };
}

const web = createNode("box", { x: 0, y: 0 }, "Web app"), api = createNode("class", { x: 400, y: 0 }, "API service");
const diagram = diagramSchema.parse({ ...createDiagram(), name: "System / overview", nodes: [web, api], edges: [{ ...createEdge(web.id, api.id), label: "uses API" }] });

async function withApp(run: (url: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "doi-uml-export-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  try { await run(`http://127.0.0.1:${app.server.port}/api/projects/sample/architecture/export`); }
  finally { app.stop(); await rm(workspace, { recursive: true, force: true }); }
}
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test.skipIf(!hasBrowser)("PNG and PDF exports render the same SVG at its size, with or without a background", async () => {
  await withApp(async url => {
    const svg = diagramSvg(diagram, { theme: "dark", background: true });
    if ("error" in svg) throw new Error(svg.error);
    const dark = await post(url, { format: "png", diagram, theme: "dark", background: true, scale: 2 });
    expect(dark.status).toBe(200);
    expect(dark.headers.get("content-type")).toBe("image/png");
    expect(dark.headers.get("content-disposition")).toBe('attachment; filename="System-overview.png"');
    const image = png(new Uint8Array(await dark.arrayBuffer()));
    expect([image.width, image.height]).toEqual([svg.width * 2, svg.height * 2]);
    expect(image.first.slice(0, 3)).toEqual([0x0e, 0x0e, 0x0d]);
    const clear = png(new Uint8Array(await (await post(url, { format: "png", diagram, theme: "light", background: false })).arrayBuffer()));
    expect(clear.first[3]).toBe(0);
    const pdf = await post(url, { format: "pdf", diagram, theme: "light", background: true });
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    const selection = png(new Uint8Array(await (await post(url, { format: "png", diagram, theme: "dark", background: true, ids: [web.id] })).arrayBuffer()));
    expect(selection.width).toBeLessThan(image.width / 2);
  });
}, 60_000);

test("export rejects bad bodies, empty selections, huge images, other origins and unknown projects", async () => {
  await withApp(async url => {
    expect((await post(url, { format: "gif", diagram, theme: "dark", background: true })).status).toBe(400);
    expect((await post(url, { format: "png", diagram: { ...diagram, nodes: [web, web] }, theme: "dark", background: true })).status).toBe(400);
    const empty = await post(url, { format: "png", diagram, theme: "dark", background: true, ids: [] });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toBe("Select one or more boxes to export.");
    const far = diagramSchema.parse({ ...diagram, nodes: [web, { ...api, position: { x: 20_000, y: 0 } }], edges: [] });
    const huge = await post(url, { format: "png", diagram: far, theme: "dark", background: true });
    expect(huge.status).toBe(413);
    expect((await huge.json()).error).toContain("Export a selection or use SVG.");
    // Each side fits, but the 2× area is 196 million pixels.
    const square = diagramSchema.parse({ ...diagram, nodes: [web, { ...api, position: { x: 6900, y: 6900 } }], edges: [] });
    const area = await post(url, { format: "png", diagram: square, theme: "dark", background: true, scale: 2 });
    expect(area.status).toBe(413);
    expect((await area.json()).error).toContain("Export a selection, use 1× or use SVG.");
    const pdfHuge = await post(url, { format: "pdf", diagram: far, theme: "dark", background: true });
    expect((await pdfHuge.json()).error).not.toContain("1×");
    expect((await post(url, { format: "png", diagram, theme: "dark", background: true }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(url.replace("/sample/", "/missing/"), { format: "png", diagram, theme: "dark", background: true })).status).toBe(404);
  });
});

test("download names keep letters, digits, inner dots and dashes", () => {
  expect(imageName("System / overview", "png")).toBe("System-overview.png");
  expect(imageName("../../etc/passwd", "pdf")).toBe("etc-passwd.pdf");
  expect(imageName(".hidden.", "png")).toBe("hidden.png");
  expect(imageName("«»", "svg")).toBe("diagram.svg");
});

test("SVG export embeds the app fonts; render failures and a missing Chromium give plain messages", async () => {
  await withApp(async url => {
    const svg = await post(url, { format: "svg", diagram, theme: "dark", background: false });
    expect(svg.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(svg.headers.get("content-disposition")).toBe('attachment; filename="System-overview.svg"');
    const text = await svg.text();
    expect(text.match(/@font-face/g)).toHaveLength(3);
    expect(text).toContain("font-family:'IBM Plex Mono'");
    expect(text).toContain("data:font/woff2;base64,");
  });
  const workspace = await mkdtemp(join(tmpdir(), "doi-uml-export-direct-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  try {
    const request = () => new Request("http://127.0.0.1/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: "png", diagram, theme: "dark", background: true }) });
    const broken = { renderPngs: async () => { throw new Error("Unable to capture screenshot"); }, renderPdf: async () => { throw new Error("no"); } };
    const failed = await postArchitectureExport(workspace, "sample", request(), broken);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "The browser could not make the image. Try again, or export SVG." });
    const missing = { renderPngs: async () => { throw new ExportError("Chromium for Playwright is not installed.", 503); }, renderPdf: async () => { throw new Error("no"); } };
    const absent = await postArchitectureExport(workspace, "sample", request(), missing);
    expect(absent.status).toBe(503);
    expect((await absent.json()).error).toContain("not installed");
  } finally { app.stop(); await rm(workspace, { recursive: true, force: true }); }
});

test.skipIf(!hasBrowser)("a PDF page has the image size", async () => {
  await withApp(async url => {
    const svg = diagramSvg(diagram, { theme: "light", background: false });
    if ("error" in svg) throw new Error(svg.error);
    const pdf = new TextDecoder("latin1").decode(await (await post(url, { format: "pdf", diagram, theme: "light", background: false })).arrayBuffer());
    const box = pdf.match(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/);
    if (!box) throw new Error("No MediaBox");
    // CSS px to PDF points: × 0.75. Chromium rounds the page to whole points.
    expect(Math.abs(Number(box[1]) - svg.width * 0.75)).toBeLessThan(1.5);
    expect(Math.abs(Number(box[2]) - svg.height * 0.75)).toBeLessThan(1.5);
    expect((pdf.match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(1);
  });
}, 60_000);
