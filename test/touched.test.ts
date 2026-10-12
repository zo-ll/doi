import { describe, expect, test } from "bun:test";
import { changedSelectors, touchedOids } from "../src/generation/touched.ts";

const design = (html: string, css = "") => [
  { path: "index.html", content: `<!doctype html><html><body>${html}</body></html>` },
  { path: "styles.css", content: css },
  { path: "logo.png", content: null },
];
const page = `<main data-oid="main"><button class="btn primary" id="buy" data-oid="cta">Buy</button><p data-oid="lead">Hi <em>there</em></p><img data-oid="logo" src="a.png"></main>`;
const css = `.btn { padding: 8px; }\np { color: gray; }\n@media (max-width: 600px) { .primary { width: 100%; } }`;

const touched = async (html: string, newCss = css, oids = ["cta", "lead", "logo", "main"]) =>
  [...(await touchedOids(design(page, css), design(html, newCss), oids))].sort();

describe("touched elements", () => {
  test("no change, no element", async () => {
    expect(await touched(page)).toEqual([]);
  });

  test("a change inside an element touches it and its parents, not its siblings", async () => {
    expect(await touched(page.replace("Buy", "Buy now"))).toEqual(["cta", "main"]);
    expect(await touched(page.replace("<em>there</em>", "<strong>there</strong>"))).toEqual(["lead", "main"]);
    expect(await touched(page.replace('src="a.png"', 'src="b.png"'))).toEqual(["logo", "main"]);
    expect(await touched(page.replace('class="btn primary"', 'class="btn primary big"'))).toEqual(["cta", "main"]);
  });

  test("a changed CSS rule touches the elements it names by class, id or data-oid", async () => {
    expect(await touched(page, css.replace("8px", "16px"))).toEqual(["cta"]);
    expect(await touched(page, css.replace("width: 100%", "width: 50%"))).toEqual(["cta"]);
    expect(await touched(page, `${css}\n#buy { color: red; }`)).toEqual(["cta"]);
    expect(await touched(page, `${css}\n[data-oid="lead"] { color: red; }`)).toEqual(["lead"]);
    expect(await touched(page, `${css}\nmain > [data-oid='logo'] { width: 2px }`)).toEqual(["logo"]);
    // A removed rule counts too.
    expect(await touched(page, css.replace(".btn { padding: 8px; }", ""))).toEqual(["cta"]);
  });

  test("a rule on a tag or on another class does not touch the element", async () => {
    expect(await touched(page, css.replace("gray", "black"))).toEqual([]);
    expect(await touched(page, `${css}\n.btn-small { padding: 2px; }\n.primaryish { x: 1 }`)).toEqual([]);
    expect(await touched(page, `/* a note */\n${css}`)).toEqual([]);
  });

  test("an element that the turn removed or that was not there is not touched", async () => {
    expect(await touched(page.replace(/<img[^>]*>/, ""), css, ["logo"])).toEqual([]);
    expect(await touched(page, css, ["new-one"])).toEqual([]);
  });
});

describe("changed CSS selectors", () => {
  test("rules in at-rules count with their own selector; @import is not a selector", () => {
    const a = `@import url(x.css);\n.a { color: red; }\n@media (min-width: 1px) { .b { color: red; } .c { x: 1 } }`;
    expect(changedSelectors(a, a)).toEqual([]);
    expect(changedSelectors(a, a.replace(".b { color: red; }", ".b { color: blue; }"))).toEqual([".b"]);
    expect(changedSelectors(a, a.replace(".a {", ".a, .z {"))).toEqual([".a", ".a, .z"]);
  });
});
