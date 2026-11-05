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
import { imageName } from "../src/server/architecture-export.ts";

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
    expect((await huge.json()).error).toContain("Export a selection, use 1× or use SVG.");
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
