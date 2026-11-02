import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { declarationLines, formatNodeCss, readNodeCss } from "../src/web/node-css.ts";

test("declarations split one per line; a ; in a value stays", () => {
  expect(declarationLines("color: red; margin: 10px;")).toEqual(["color: red", "margin: 10px"]);
  expect(declarationLines('content: "a; b"; --x: 1px;')).toEqual(['content: "a; b"', "--x: 1px"]);
  expect(declarationLines('content: "a; b: c"; width: 3px')).toEqual(['content: "a; b: c"', "width: 3px"]);
  const svg = `url("data:image/svg+xml,<svg><rect style='fill:red;stroke:blue'/></svg>")`;
  expect(declarationLines(`background-image: ${svg}; color: red;`)).toEqual([`background-image: ${svg}`, "color: red"]);
  expect(declarationLines("")).toEqual([]);
});

test("the CSS block shows the style attribute, then each rule with its source and at-rules", () => {
  const out = formatNodeCss({
    inline: "width: 300px;",
    rules: [
      { selector: ".card", declarations: "color: blue; margin: 10px;", within: [], source: "styles.css" },
      { selector: ".card", declarations: "padding: 24px;", within: ["@media (min-width: 600px)"], source: "<style>" },
    ],
  });
  expect(out).toBe(
    [
      "/* style attribute */\nelement.style {\n  width: 300px;\n}",
      "/* styles.css */\n.card {\n  color: blue;\n  margin: 10px;\n}",
      "/* <style> */\n@media (min-width: 600px) {\n  .card {\n    padding: 24px;\n  }\n}",
    ].join("\n\n"),
  );
  expect(formatNodeCss({ inline: "", rules: [] })).toBe("");
});

// readNodeCss runs on a page's document; CI installs Chromium, so only a local run skips.
const hasBrowser = await chromium.launch().then(
  (b) => b.close().then(() => true),
  () => false,
);
test.if(!!process.env.CI)("CI has Chromium for the node CSS tests", () => {
  expect(hasBrowser).toBe(true);
});

test.skipIf(!hasBrowser)("readNodeCss gives the matching rules with their at-rules, and the style attribute", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<style>a { color: red; } [data-oid=x] .no { color: blue; } @media (min-width: 99999px) { .b { margin: 1px; } } @supports (display: grid) { a.b { gap: 2px; } }' +
        ".card { & .inner { color: green; } .plain { padding: 1px; } } .panel { color: green; @media (min-width: 1px) { color: blue; } }</style>" +
        '<a class="b" data-oid="x" style="width: 3px">x</a><div class="card"><span class="inner plain" data-oid="in">i</span></div><div class="panel" data-oid="panel">p</div>',
    );
    const read = (oid: string) => page.evaluate(`(${readNodeCss.toString()})(document, ${JSON.stringify(oid)})`);
    expect(await read("x")).toEqual({
      inline: "width: 3px",
      rules: [
        { selector: "a", declarations: "color: red;", within: [], source: "<style>" },
        // a @media that does not apply at this width is listed too
        { selector: ".b", declarations: "margin: 1px;", within: ["@media (min-width: 99999px)"], source: "<style>" },
        { selector: "a.b", declarations: "gap: 2px;", within: ["@supports (display: grid)"], source: "<style>" },
      ],
    });
    // nested rules: `&` is the parent, no `&` is a descendant; the parent without declarations is left out
    expect(await read("in")).toEqual({
      inline: "",
      rules: [
        { selector: "& .inner", declarations: "color: green;", within: [".card"], source: "<style>" },
        { selector: "& .plain", declarations: "padding: 1px;", within: [".card"], source: "<style>" }, // Chromium adds the &
      ],
    });
    // declarations inside a nested @media belong to the rule around them
    expect(await read("panel")).toEqual({
      inline: "",
      rules: [
        { selector: ".panel", declarations: "color: green;", within: [], source: "<style>" },
        { selector: "&", declarations: "color: blue;", within: [".panel", "@media (min-width: 1px)"], source: "<style>" },
      ],
    });
    expect(await read("nope")).toBeNull();
  } finally {
    await browser.close();
  }
});
