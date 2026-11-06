import { chromium, type Browser, type Page } from "playwright-core";
import { PAGE_CSP } from "../server/security.ts";
import type { Frame } from "../workspace/frames.ts";
import { CHROMIUM_ARGS } from "./browser.ts";
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
  /** No white page behind a transparent document (a UML export without a background). */
  transparent?: boolean;
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
    return await chromium.launch({ timeout: TIMEOUT_MS, args: CHROMIUM_ARGS });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/Executable doesn't exist/i.test(message)) {
      throw new ExportError("Chromium for Playwright is not installed. Run: doi install-browser (from the source: bun run install-browser)", 503);
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
      out.push(await page.screenshot({ type: "png", fullPage: options.fullPage, omitBackground: options.transparent ?? false }));
      await page.context().close();
    }
    return out;
  });
}

/** Slides are the outermost elements with `data-slide`. A deck makes one PDF page per slide. */
export const SLIDE_SELECTOR = "[data-slide]";

/**
 * Prepares a deck for print in the page: only the slides stay, each at the size of the first
 * slide, one slide per PDF page. The elements around the slides lose their own box (margin,
 * padding, border, gap, position, transform, zoom, writing mode), their other children are
 * hidden and their bare text is removed, so a title, text or the space between slides on the
 * canvas does not go into the PDF. Gives null when the page has
 * no slides. Runs inside the page: it must not use anything from this module.
 */
export function prepareSlides(selector: string): { width: number; height: number; count: number } | null {
  const slides = [...document.querySelectorAll<HTMLElement>(selector)].filter((e) => !e.parentElement?.closest(selector));
  if (!slides.length) return null;
  const set = (e: HTMLElement, props: Record<string, string>) => {
    for (const [k, v] of Object.entries(props)) e.style.setProperty(k, v, "important");
  };
  // A slide keeps a writing mode that it sets itself. One that it only inherits from the elements
  // around it goes away with theirs.
  const modes = slides.map((s) => {
    const own = getComputedStyle(s).writingMode;
    return s.parentElement && getComputedStyle(s.parentElement).writingMode === own ? "" : own;
  });
  const around = new Set<Element>();
  for (const s of slides) for (let e = s.parentElement; e; e = e.parentElement) around.add(e);
  const isSlide = new Set<Element>(slides);
  for (const a of around) {
    if (!(a instanceof HTMLElement)) continue;
    set(a, {
      display: "block", margin: "0", padding: "0", border: "0", gap: "0", width: "auto", height: "auto",
      "min-height": "0", "max-height": "none", overflow: "visible", position: "static", columns: "auto",
      transform: "none", translate: "none", rotate: "none", scale: "none", zoom: "1", "writing-mode": "horizontal-tb",
      contain: "none", "content-visibility": "visible",
    });
    if (a instanceof HTMLDetailsElement) a.open = true;
    for (const c of [...a.childNodes]) {
      // Bare text between slides would make a line box, and so a page of its own.
      if (c.nodeType === Node.TEXT_NODE) c.remove();
      else if ((c instanceof HTMLElement || c instanceof SVGElement) && !around.has(c) && !isSlide.has(c)) set(c as HTMLElement, { display: "none" });
    }
  }
  // The content box of an open details element has its own box and visibility.
  const style = document.createElement("style");
  style.textContent = "details::details-content { display: block !important; content-visibility: visible !important; margin: 0 !important; padding: 0 !important; border: 0 !important; }";
  document.head.append(style);
  slides.forEach((s, i) => {
    if (getComputedStyle(s).display === "none") set(s, { display: "block" });
    if (modes[i]) set(s, { "writing-mode": modes[i]! });
    // A float, because Chromium adds an empty page after a slide in another writing mode
    // that is in normal flow. Each float clears the one before, so it starts a new page.
    set(s, {
      margin: "0", "box-sizing": "border-box", position: "relative", inset: "auto", flex: "none", float: "left", clear: "both",
      transform: "none", translate: "none", rotate: "none", scale: "none", zoom: "1",
    });
  });
  // Measure only now: before, a hidden, zoomed or transformed wrapper changes the first slide's box.
  const box = slides[0]!.getBoundingClientRect();
  const width = Math.round(box.width) || window.innerWidth;
  const height = Math.round(box.height) || window.innerHeight;
  slides.forEach((s, i) =>
    set(s, {
      width: `${width}px`, height: `${height}px`, overflow: "hidden",
      "break-inside": "avoid", "break-after": i < slides.length - 1 ? "page" : "auto",
    }),
  );
  return { width, height, count: slides.length };
}

const NO_MARGIN = { top: "0", right: "0", bottom: "0", left: "0" };

/**
 * A PDF of one frame. A deck (elements with `data-slide`) gives one page per slide, at the
 * size of the first slide. Any other page gives one page as wide as the frame and as high as
 * the whole page (up to PDF_MAX_HEIGHT). Both with backgrounds, in screen media.
 */
export function renderPdf(html: string, frame: Pick<Frame, "width" | "height">): Promise<Buffer> {
  return withBrowser(async (browser) => {
    const page = await openPage(browser, html, frame, 1);
    const deck = await page.evaluate(prepareSlides, SLIDE_SELECTOR);
    if (deck) {
      const side = (px: number) => `${Math.min(px, PDF_MAX_HEIGHT)}px`;
      return page.pdf({ width: side(deck.width), height: side(deck.height), printBackground: true, margin: NO_MARGIN });
    }
    const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
    return page.pdf({
      width: `${frame.width}px`,
      height: `${Math.min(Math.max(height, frame.height), PDF_MAX_HEIGHT)}px`,
      printBackground: true,
      margin: NO_MARGIN,
    });
  });
}
