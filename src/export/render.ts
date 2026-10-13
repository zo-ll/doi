import { chromium, type Browser, type Page } from "playwright-core";
import { PAGE_CSP } from "../server/security.ts";
import type { Frame } from "../workspace/frames.ts";
import { ExportError } from "./html.ts";

/**
 * PNG and PDF export (#47) with Playwright Chromium. The input is the single-file export of a
 * page (`exportPage()`), so every local file is already inline. During a render the page can
 * reach only the font hosts that PAGE_CSP allows. Two barriers: a route fails every other
 * request, and the page comes with PAGE_CSP as a header, which also stops what the route does
 * not see (navigator.sendBeacon).
 */
export const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

/** Chromium limits a PDF page to 200 inches: 19 200 CSS pixels. Longer pages go on to a second page. */
export const PDF_MAX_HEIGHT = 19_200;
const TIMEOUT_MS = 30_000;
/** The address of the page during a render. Only the route answers it; the name never resolves. */
const PAGE_URL = "http://render.doi.invalid/";

export interface PngOptions {
  /** Device pixels per CSS pixel: 1 or 2. */
  scale: number;
  /** The whole page height, not only the frame's viewport. */
  fullPage: boolean;
}

/** True when a request may leave the render: data and blob URLs, and the font hosts over HTTPS. */
export function allowedRequest(url: string): boolean {
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && FONT_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

async function launch(): Promise<Browser> {
  try {
    // WebRTC sends UDP that neither the route nor the CSP sees. Without a proxy, this policy
    // gives WebRTC no UDP at all; the init script in openPage() also removes the API.
    return await chromium.launch({ timeout: TIMEOUT_MS, args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/Executable doesn't exist/i.test(message)) {
      throw new ExportError("Chromium for Playwright is not installed. Run: bun run install-browser", 503);
    }
    throw e;
  }
}

/** Removes the WebRTC classes in every frame before the page's own scripts run. */
const NO_WEBRTC = `for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCRtpSender", "RTCRtpReceiver", "RTCRtpTransceiver", "RTCIceCandidate", "RTCSessionDescription"]) {
  try { Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false }); } catch {}
}`;

/** Opens `html` in a new page at the frame's size, with the network rules. */
async function openPage(browser: Browser, html: string, frame: Pick<Frame, "width" | "height">, scale: number): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: frame.width, height: frame.height },
    deviceScaleFactor: scale,
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  context.setDefaultTimeout(TIMEOUT_MS);
  await context.addInitScript(NO_WEBRTC);
  let served = false;
  await context.route("**/*", (route) => {
    const request = route.request();
    const url = request.url();
    // The page loads once. A later navigation (a form, a refresh, a link) gets 204 No Content,
    // and the browser keeps the page. (An aborted navigation shows Chromium's error page.)
    if (request.isNavigationRequest() && (served || url !== PAGE_URL)) return route.fulfill({ status: 204 });
    if (url === PAGE_URL) {
      served = true;
      return route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: { "content-security-policy": PAGE_CSP },
        body: html,
      });
    }
    return allowedRequest(url) ? route.continue() : route.abort("blockedbyclient");
  });
  await context.routeWebSocket(/.*/, (ws) => ws.close());
  const page = await context.newPage();
  await page.emulateMedia({ media: "screen" });
  // A navigation that the page starts while it loads (a form, location.href) stops
  // Playwright's wait for "load", so the wait is for the document's own state.
  await page.goto(PAGE_URL, { waitUntil: "commit" });
  await page.waitForFunction(() => document.readyState === "complete");
  // Web fonts load after the load event; a capture before that shows the fallback font.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return page;
}

async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await launch();
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

/** Runs `fn` on the page as it renders, then closes the browser. For tests and checks. */
export function inspectRender<T>(html: string, frame: Pick<Frame, "width" | "height">, fn: (page: Page) => Promise<T>): Promise<T> {
  return withBrowser(async (browser) => fn(await openPage(browser, html, frame, 1)));
}

/** One PNG per frame, in order: the frame's viewport, or the whole page height. One browser for all. */
export function renderPngs(html: string, frames: Pick<Frame, "width" | "height">[], options: PngOptions): Promise<Buffer[]> {
  return withBrowser(async (browser) => {
    const out: Buffer[] = [];
    for (const frame of frames) {
      const page = await openPage(browser, html, frame, options.scale);
      out.push(await page.screenshot({ type: "png", fullPage: options.fullPage }));
      await page.context().close();
    }
    return out;
  });
}

/**
 * A PDF of one frame: one page as wide as the frame and as high as the whole page (up to
 * PDF_MAX_HEIGHT), with backgrounds, in screen media.
 */
export function renderPdf(html: string, frame: Pick<Frame, "width" | "height">): Promise<Buffer> {
  return withBrowser(async (browser) => {
    const page = await openPage(browser, html, frame, 1);
    const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
    return page.pdf({
      width: `${frame.width}px`,
      height: `${Math.min(Math.max(height, frame.height), PDF_MAX_HEIGHT)}px`,
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
  });
}
