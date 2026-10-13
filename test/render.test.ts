import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { allowedRequest, inspectRender, prepareSlides, renderPdf, renderPngs, SLIDE_SELECTOR } from "../src/export/render.ts";

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

// The render tests need Chromium (`bun run install-browser`). They skip without it, except in
// CI, which installs it: there a missing browser must fail, not skip.
const hasBrowser = await chromium.launch().then(
  (b) => b.close().then(() => true),
  () => false,
);
test.if(!!process.env.CI)("CI has Chromium for the render tests", () => {
  expect(hasBrowser).toBe(true);
});

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

  test("a deck gives one PDF page per slide, without the content around the slides", async () => {
    const slide = (n: number) => `<section class="slide" data-slide><h1>Slide ${n}</h1><section data-slide>inner</section></section>`;
    const html = page(`<style>
      body { padding: 40px; background: #888 }
      .deck { display: flex; flex-direction: column; gap: 48px; padding: 32px; border: 4px solid red }
      .slide { width: 960px; height: 540px; padding: 64px; box-sizing: border-box; background: #fdd }
      .hidden { display: none }
    </style>
    <header>Deck title</header>
    <main class="deck">${slide(1)}${slide(2)}<p>between</p><div class="hidden">${slide(3)}</div></main>`);
    const pdf = (await renderPdf(html, { width: 1920, height: 1080 })).toString("latin1");
    // Three outer slides (the inner data-slide is part of its slide), each 960 × 540 px = 720 × 405 pt.
    // Chromium rounds the page size a little (405 pt becomes 404.88 pt).
    expect(pdf.match(/\/Type\s*\/Page\b/g)?.length).toBe(3);
    const boxes = [...pdf.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(boxes.length).toBe(3);
    for (const [w, h] of boxes) {
      expect(w).toBeCloseTo(720, 0);
      expect(h).toBeCloseTo(405, 0);
    }
  }, 60_000);

  test("a deck PDF ignores hidden, zoomed, transformed and vertical wrappers and bare text, and keeps vertical slides", async () => {
    const slides = '<div class="slide" data-slide>A</div> text <div class="slide" data-slide>B</div> more text ';
    const css = ".slide { width: 960px; height: 540px; background: #fdd }";
    for (const wrapper of [
      "display: none",
      "transform: scale(0.5)",
      "scale: 0.5",
      "zoom: 0.5",
      "writing-mode: vertical-rl",
      "display: grid; grid-template-columns: 1fr 1fr; padding: 20px",
      "columns: 2",
      // A slide's own writing mode stays.
      "--own: 1",
    ]) {
      const own = wrapper === "--own: 1" ? ".slide { writing-mode: vertical-rl }" : "";
      const html = page(`<style>${css} ${own}</style><div style="${wrapper}">bare ${slides}</div>`);
      const pdf = (await renderPdf(html, { width: 1440, height: 900 })).toString("latin1");
      const boxes = [...pdf.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
      expect({ wrapper, pages: boxes.length }).toEqual({ wrapper, pages: 2 });
      for (const [w, h] of boxes) {
        expect(w).toBeCloseTo(720, 0);
        expect(h).toBeCloseTo(405, 0);
      }
    }
  }, 120_000);

  test("in a deck, only the slides are visible, each at the first slide's size", async () => {
    const html = page(`<style>.slide { width: 400px; height: 300px } .b { width: 200px }</style>
      <h2>Title</h2><div class="slide" data-slide>A</div><p>between</p><div class="slide b" data-slide>B</div>`);
    const seen = await inspectRender(html, { width: 800, height: 600 }, async (p) => {
      await p.evaluate(prepareSlides, SLIDE_SELECTOR);
      return p.evaluate(() =>
        [...document.body.children].flatMap((e) => {
          const box = e.getBoundingClientRect();
          return box.width ? [{ text: (e as HTMLElement).innerText, width: box.width, height: box.height }] : [];
        }),
      );
    });
    expect(seen).toEqual([
      { text: "A", width: 400, height: 300 },
      { text: "B", width: 400, height: 300 },
    ]);
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

  test("WebRTC cannot send UDP packets, not even from a new frame", async () => {
    let packets = 0;
    const udp = await Bun.udpSocket({ hostname: "127.0.0.1", socket: { data: () => void packets++ } });
    const stun = `stun:127.0.0.1:${udp.port}`;
    const html = page(`<script>
      const open = (RTC) => {
        try {
          const pc = new RTC({ iceServers: [{ urls: "${stun}" }] });
          pc.createDataChannel("x");
          pc.createOffer().then((o) => pc.setLocalDescription(o));
        } catch {}
      };
      open(window.RTCPeerConnection);
      open(window.webkitRTCPeerConnection);
      const f = document.createElement("iframe");
      document.body.append(f);
      open(f.contentWindow.RTCPeerConnection);
    </script>`);
    await renderPngs(html, [{ width: 300, height: 200 }], { scale: 1, fullPage: false });
    await Bun.sleep(500);
    udp.close();
    expect(packets).toBe(0);
  }, 60_000);

  test("a page that submits a form or refreshes itself still renders", async () => {
    const started = Date.now();
    const form = page(`<form id="f" action="https://example.com/" method="post"><input name="a"></form><script>document.getElementById("f").submit()</script><p>form</p>`);
    const refresh = `<!doctype html><html><head><meta http-equiv="refresh" content="0"></head><body><p>refresh</p></body></html>`;
    const away = page(`<script>location.href = "https://example.com/"</script><p>away</p>`);
    // Chromium stops parsing a page at a navigation that starts during the parse (a form
    // submit, location.href), so the text after the script is not there. The URL shows that
    // the page is still the first one, not Chromium's error page (chrome-error://).
    for (const [html, text] of [[form, ""], [refresh, "refresh"], [away, ""]] as const) {
      // The first page stays: not another site, not Chromium's error page.
      const seen = await inspectRender(html, { width: 300, height: 200 }, async (p) => {
        await Bun.sleep(300);
        return { url: p.url(), text: (await p.innerText("body")).trim() };
      });
      expect(seen).toEqual({ url: "http://render.doi.invalid/", text });
      const [png] = await renderPngs(html, [{ width: 300, height: 200 }], { scale: 1, fullPage: false });
      expect(pngSize(png!)).toEqual({ width: 300, height: 200 });
      expect((await renderPdf(html, { width: 300, height: 200 })).subarray(0, 5).toString()).toBe("%PDF-");
    }
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 120_000);
});
