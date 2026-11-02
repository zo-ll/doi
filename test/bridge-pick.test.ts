import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";

// The click rule of the bridge in a real browser. Skips without Chromium, except in CI.
const bridge = await Bun.file(new URL("../src/frame/bridge.js", import.meta.url)).text();
const hasBrowser = await chromium.launch().then(
  (b) => b.close().then(() => true),
  () => false,
);
test("CI has Chromium for the bridge tests", () => {
  if (process.env.CI) expect(hasBrowser).toBe(true);
});

const PAGE = `<!doctype html><html><body style="margin:0">
<main data-oid="main" style="padding:20px">
  <section data-oid="hero" style="padding:20px">
    <div data-oid="actions" style="padding:20px">
      <a data-oid="cta" href="#" style="display:inline-block;padding:10px"><span>Start</span></a>
      <a data-oid="more" href="#" style="display:inline-block;padding:10px">More</a>
    </div>
    <p data-oid="lede">Lede</p>
  </section>
  <section data-oid="features"><h2 data-oid="f-title">Features</h2></section>
</main></body></html>`;

describe.skipIf(!hasBrowser)("bridge: a click picks one level deeper", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  /** A fresh page; the app's role (selection → doi:track) is played here. */
  async function open(deepest = false) {
    page = await browser.newPage();
    await page.setContent(PAGE);
    await page.evaluate((deep) => {
      const w = window as any;
      w.picks = [];
      w.hover = null;
      addEventListener("message", (e) => {
        const d = e.data;
        if (d?.type === "doi:select") {
          w.picks.push(d.oid);
          postMessage({ type: "doi:track", oid: d.oid, pins: [], deepest: deep }, "*");
        }
        if (d?.type === "doi:rects") w.hover = d.hover?.oid ?? null;
      });
    }, deepest);
    await page.addScriptTag({ content: bridge });
    await page.evaluate((deep) => postMessage({ type: "doi:track", oid: null, pins: [], deepest: deep }, "*"), deepest);
    await page.waitForTimeout(30);
  }
  const click = async (selector: string, modifiers: ("Shift" | "ControlOrMeta")[] = []) => {
    await page.click(selector, { modifiers });
    await page.waitForTimeout(30);
    return page.evaluate(() => (window as any).picks.at(-1));
  };

  test("each click on the same spot goes one level deeper, then stays", async () => {
    await open();
    expect(await click("span")).toBe("main");
    expect(await click("span")).toBe("hero");
    expect(await click("span")).toBe("actions");
    expect(await click("span")).toBe("cta");
    expect(await click("span")).toBe("cta");
  });

  test("a click elsewhere picks at the level where it meets the selection", async () => {
    await open();
    for (let i = 0; i < 4; i++) await click("span"); // cta
    expect(await click("[data-oid=more]")).toBe("more"); // a sibling
    expect(await click("[data-oid=lede]")).toBe("lede"); // a sibling of an ancestor
    expect(await click("[data-oid=f-title]")).toBe("features"); // meets at main
  });

  test("Ctrl/⌘ + click picks the deepest; Shift + click the parent", async () => {
    await open();
    expect(await click("span", ["ControlOrMeta"])).toBe("cta");
    expect(await click("span", ["Shift"])).toBe("actions");
  });

  test("the Comment tool picks the deepest element at once", async () => {
    await open(true);
    expect(await click("span")).toBe("cta");
  });

  test("the hover outline shows what a click would pick", async () => {
    await open();
    await click("span"); // main
    await page.mouse.move(0, 0);
    await page.hover("[data-oid=lede]");
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => (window as any).hover)).toBe("hero");
  });
});
