import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixDesignOids, fixOids } from "../src/generation/oids.ts";

const page = (body: string) => `<!doctype html>\n<html><head><title>T</title></head><body>\n${body}\n</body></html>\n`;
const files = (body: string, more: Record<string, string> = {}) => [
  { path: "index.html", content: page(body) },
  { path: "styles.css", content: "p { color: red; }" },
  ...Object.entries(more).map(([path, content]) => ({ path, content })),
];
const oids = (html: string) => [...html.matchAll(/data-oid="([^"]*)"/g)].map((m) => m[1]);

async function fix(before: string, after: string) {
  const { files: out, changes } = await fixOids(files(before), files(after));
  return { html: out.find((f) => f.path === "index.html")?.content ?? null, changes, count: out.length };
}

describe("data-oid post-processing", () => {
  test("a design with valid, unique ids is not changed", async () => {
    const body = `<main data-oid="main"><h1 data-oid="title">Hi <em>there</em></h1><img src="a.png" alt="" data-oid="hero"></main>`;
    expect(await fix(body, body)).toEqual({ html: null, changes: { added: [], restored: [] }, count: 0 });
  });

  test("adds ids to meaningful elements, and only to those", async () => {
    const { html, changes } = await fix(
      `<main data-oid="main"></main>`,
      `<main data-oid="main"><section><h2>Plans for teams</h2><p>Pay <strong>less</strong>.</p><img src="x.png"><br><span>s</span></section></main>`,
    );
    expect(changes.added).toEqual(["section-plans-for-teams", "h2-plans-for-teams", "p-pay-less", "img"]);
    expect(html).toContain(`<section data-oid="section-plans-for-teams"><h2 data-oid="h2-plans-for-teams">`);
    expect(html).toContain(`<img src="x.png" data-oid="img">`);
    // Head elements, inline formatting, line breaks and spans stay without an id.
    expect(html).toContain(`<title>T</title>`);
    expect(html).toContain(`<strong>less</strong>`);
    expect(html).toContain(`<br><span>s</span>`);
  });

  test("restores a dropped id when the tag and the text match", async () => {
    const { html, changes } = await fix(
      `<main data-oid="main"><h1 data-oid="title">Field notes</h1><p data-oid="lead">Every Friday</p></main>`,
      `<main data-oid="main"><h1>Field notes</h1><p class="big">Every Friday</p><p>New line</p></main>`,
    );
    expect(changes).toEqual({ added: ["p-new-line"], restored: ["title", "lead"] });
    expect(oids(html!)).toEqual(["main", "title", "lead", "p-new-line"]);
    expect(html).toContain(`<p class="big" data-oid="lead">Every Friday</p>`);
  });

  test("a dropped id does not go to an element with other text or another tag", async () => {
    const { html } = await fix(
      `<main data-oid="main"><h1 data-oid="title">Field notes</h1></main>`,
      `<main data-oid="main"><h1>Other words</h1><h2>Field notes</h2></main>`,
    );
    expect(oids(html!)).toEqual(["main", "h1-other-words", "h2-field-notes"]);
  });

  test("images without text match by their attributes", async () => {
    const { html } = await fix(
      `<main data-oid="main"><img src="a.png" data-oid="first"><img src="b.png" data-oid="second"></main>`,
      `<main data-oid="main"><img src="b.png"><img src="a.png"></main>`,
    );
    expect(html).toContain(`<img src="b.png" data-oid="second"><img src="a.png" data-oid="first">`);
  });

  test("an id the model changed stays changed", async () => {
    const { html, changes } = await fix(
      `<main data-oid="main"><button data-oid="cta">Buy</button></main>`,
      `<main data-oid="main"><button data-oid="buy-button">Buy</button></main>`,
    );
    expect(html).toBeNull();
    expect(changes).toEqual({ added: [], restored: [] });
  });

  test("a duplicate id stays on the element that had it, and the copy gets a new id", async () => {
    const { html, changes } = await fix(
      `<main data-oid="main"><div data-oid="card">Basic</div></main>`,
      // The model copied the card and put the copy first.
      `<main data-oid="main"><div data-oid="card">Pro</div><div data-oid="card">Basic</div></main>`,
    );
    expect(changes.added).toEqual(["div-pro"]);
    expect(html).toContain(`<div data-oid="div-pro">Pro</div><div data-oid="card">Basic</div>`);
  });

  test("a new duplicate id stays on the first element", async () => {
    const { html } = await fix(
      `<main data-oid="main"></main>`,
      `<main data-oid="main"><p data-oid="x">One</p><p data-oid="x">Two</p><p data-oid="x">Two</p></main>`,
    );
    expect(oids(html!)).toEqual(["main", "x", "p-two", "p-two-2"]);
  });

  test("ids are unique across all pages of a design", async () => {
    const { files: out } = await fixOids(
      files(`<main data-oid="main"></main>`),
      files(`<main data-oid="main"></main>`, { "about.html": page(`<main data-oid="main"><p>About</p></main>`) }),
    );
    expect(out.map((f) => f.path)).toEqual(["about.html"]);
    expect(oids(out[0]!.content)).toEqual(["main-about", "p-about"]);
  });

  test("an invalid id is replaced, so it can be a target", async () => {
    const { html } = await fix(`<main data-oid="main"></main>`, `<main data-oid="main"><p data-oid="my para">Hi</p><p data-oid="">Yo</p></main>`);
    expect(oids(html!)).toEqual(["main", "p-hi", "p-yo"]);
  });

  test("elements inside svg and template get no id; the svg gets one", async () => {
    const { html } = await fix(
      `<main data-oid="main"></main>`,
      `<main data-oid="main"><svg viewBox="0 0 1 1"><a href="#"><path d="M0"/></a></svg><template><p>t</p></template></main>`,
    );
    expect(oids(html!)).toEqual(["main", "svg"]);
  });

  test("an implied end tag does not mix up the text of the elements", async () => {
    const { html } = await fix(
      `<main data-oid="main"></main>`,
      `<main data-oid="main"><ul><li>One<li>Two</ul><p>After</p></main>`,
    );
    expect(oids(html!)).toEqual(["main", "ul-one-two", "li-one", "li-two", "p-after"]);
  });

  test("only the changed start tags differ; the rest stays byte for byte", async () => {
    const before = `<main data-oid="main"></main>`;
    const after = `<main   class='a'  data-oid="main">\n  <p>Tom &amp; Jerry</p>  <!-- note -->\n</main>`;
    const { html } = await fix(before, after);
    expect(html).toBe(page(after).replace("<p>", `<p data-oid="p-tom-amp-jerry">`));
  });

  test("fixDesignOids writes the changed files and returns their paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doi-oids-"));
    const after = files(`<main data-oid="main"><p>New</p></main>`);
    for (const f of after) await Bun.write(join(dir, f.path), f.content);
    expect(await fixDesignOids(dir, files(`<main data-oid="main"></main>`), after)).toEqual(["index.html"]);
    expect(await Bun.file(join(dir, "index.html")).text()).toContain(`<p data-oid="p-new">New</p>`);
  });
});
