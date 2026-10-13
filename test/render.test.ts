import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { allowedRequest, renderPdf, renderPngs } from "../src/export/render.ts";

/** Width and height from the IHDR chunk of a PNG. */
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

describe("allowedRequest", () => {
  test("allows data, blob and the font hosts over HTTPS only", () => {
    expect(allowedRequest("data:image/png;base64,AA")).toBe(true);
    expect(allowedRequest("blob:null/1234")).toBe(true);
    expect(allowedRequest("https://fonts.googleapis.com/css2?family=Inter")).toBe(true);
    expect(allowedRequest("https://fonts.gstatic.com/s/inter/v1/a.woff2")).toBe(true);
    for (const url of [
      "http://fonts.googleapis.com/css2",
      "https://fonts.googleapis.com.evil.test/x",
      "http://127.0.0.1:4317/api/projects",
      "https://example.com/a.png",
      "file:///etc/passwd",
      "ws://127.0.0.1:1/",
      "not a url",
    ]) {
      expect(allowedRequest(url)).toBe(false);
    }
  });
});

// The render tests need Chromium (`bun run install-browser`); CI installs it.
const hasBrowser = existsSync(chromium.executablePath());

describe.skipIf(!hasBrowser)("render with Chromium", () => {
  let hits: string[] = [];
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        hits.push(new URL(req.url).pathname);
        return new Response("x");
      },
    });
  });
  afterAll(() => server.stop(true));

  const page = (body: string) => `<!doctype html><html><head><style>html,body{margin:0}</style></head><body>${body}</body></html>`;

  test("a PNG has the frame size times the scale, or the whole page height", async () => {
    const html = page('<div style="height:1000px;background:#c00"></div>');
    const [one, two, full] = [
      ...(await renderPngs(html, [{ width: 300, height: 200 }], { scale: 1, fullPage: false })),
      ...(await renderPngs(html, [{ width: 300, height: 200 }], { scale: 2, fullPage: false })),
      ...(await renderPngs(html, [{ width: 300, height: 200 }], { scale: 1, fullPage: true })),
    ];
    expect(pngSize(one!)).toEqual({ width: 300, height: 200 });
    expect(pngSize(two!)).toEqual({ width: 600, height: 400 });
    expect(pngSize(full!)).toEqual({ width: 300, height: 1000 });
  }, 60_000);

  test("one browser renders each frame at its own size", async () => {
    const pngs = await renderPngs(page("<p>x</p>"), [{ width: 400, height: 300 }, { width: 250, height: 500 }], { scale: 1, fullPage: false });
    expect(pngs.map(pngSize)).toEqual([{ width: 400, height: 300 }, { width: 250, height: 500 }]);
  }, 60_000);

  test("a PDF page is as wide as the frame and as high as the page", async () => {
    const pdf = await renderPdf(page('<div style="height:1600px;background:#00c"></div>'), { width: 800, height: 600 });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    // 1 CSS pixel = 0.75 pt.
    expect(pdf.toString("latin1")).toMatch(/\/MediaBox \[0 0 600 1200\]/);
  }, 60_000);

  test("the page cannot reach the network", async () => {
    hits = [];
    const base = `http://127.0.0.1:${server.port}`;
    const html = page(`
      <link rel="stylesheet" href="${base}/style.css">
      <img src="${base}/image.png">
      <iframe src="${base}/frame"></iframe>
      <script>
        fetch("${base}/fetch").catch(() => {});
        navigator.sendBeacon("${base}/beacon", "x");
        try { new WebSocket("ws://127.0.0.1:${server.port}/ws"); } catch {}
      </script>`);
    await renderPngs(html, [{ width: 300, height: 200 }], { scale: 1, fullPage: false });
    await renderPdf(html, { width: 300, height: 200 });
    expect(hits).toEqual([]);
  }, 60_000);
});
