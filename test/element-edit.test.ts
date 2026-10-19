import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSpacing, postEdit, undoEdit } from "../src/server/element-edit.ts";
import { DesignLocks } from "../src/server/locks.ts";
import { checkStyle, EditError, moveElement, spacingScale, withElementStyle } from "../src/workspace/element-edit.ts";
import { commitPaths, designLog, ensureRepo } from "../src/workspace/git.ts";
import { designDir } from "../src/workspace/paths.ts";

describe("element style", () => {
  test("a new rule goes at the end of the file", () => {
    const css = ".card { padding: 8px; }\n";
    expect(withElementStyle(css, "card-1", { width: "320px", height: "auto" })).toBe(
      '.card { padding: 8px; }\n\n[data-oid="card-1"] {\n  width: 320px;\n  height: auto;\n}\n',
    );
  });

  test("an existing rule keeps its other declarations; max-width is not width", () => {
    const css = '[data-oid="a"] {\n  max-width: 40px;\n  width: 10px;\n  color: red;\n}\n.b {}\n';
    expect(withElementStyle(css, "a", { width: "20px", "margin-top": "var(--space-2)" })).toBe(
      '[data-oid="a"] {\n  max-width: 40px;\n  width: 20px;\n  color: red;\n  margin-top: var(--space-2);\n}\n.b {}\n',
    );
  });

  test("null removes a declaration, and an empty rule goes away", () => {
    const css = '.x { color: red; }\n\n[data-oid="a"] {\n  width: 10px;\n  height: 5px;\n}\n.y {}\n';
    expect(withElementStyle(css, "a", { width: null })).toBe('.x { color: red; }\n\n[data-oid="a"] {\n  height: 5px;\n}\n.y {}\n');
    expect(withElementStyle(css, "a", { width: null, height: null })).toBe(".x { color: red; }\n.y {}\n");
  });

  test("only a top-level rule with exactly this selector; comments and @media rules do not count", () => {
    const css = '/* [data-oid="a"] { width: 1px } */\n@media (min-width: 9px) { [data-oid="a"] { width: 2px; } }\n.p [data-oid="a"] { width: 3px; }\n';
    const out = withElementStyle(css, "a", { width: "4px" });
    expect(out.startsWith(css)).toBe(true);
    expect(out.slice(css.length)).toBe('\n[data-oid="a"] {\n  width: 4px;\n}\n');
  });

  test("checkStyle accepts lengths, auto, var() for margins and align keywords only", () => {
    expect(checkStyle({ width: "12.5px", "margin-left": "-8px", "margin-top": "var(--space-3)", "align-self": "center", height: null })).toEqual({
      width: "12.5px",
      "margin-left": "-8px",
      "margin-top": "var(--space-3)",
      "align-self": "center",
      height: null,
    });
    for (const bad of [{ color: "red" }, { width: "-4px" }, { width: "var(--x)" }, { width: "1px; color: red" }, { "align-self": "middle" }, {}, []]) {
      expect(() => checkStyle(bad)).toThrow(EditError);
    }
  });
});

describe("move element", () => {
  const html = `<main data-oid="main">
  <section data-oid="a">A</section>
  <section data-oid="b">B <p data-oid="b-text">x</p></section>
  <img data-oid="c" src="c.png">
</main>`;

  test("before and after a sibling; the rest stays byte for byte", async () => {
    expect(await moveElement(html, "c", "a", "before")).toBe(`<main data-oid="main">
  <img data-oid="c" src="c.png">
  <section data-oid="a">A</section>
  <section data-oid="b">B <p data-oid="b-text">x</p></section>
</main>`);
    expect(await moveElement(html, "a", "b", "after")).toBe(`<main data-oid="main">
  <section data-oid="b">B <p data-oid="b-text">x</p></section>
  <section data-oid="a">A</section>
  <img data-oid="c" src="c.png">
</main>`);
  });

  test("only siblings, known ids, and elements with an end tag", async () => {
    const fail = async (p: Promise<string>, status: number) => {
      const e = await p.catch((x) => x);
      expect(e).toBeInstanceOf(EditError);
      expect(e.status).toBe(status);
    };
    await fail(moveElement(html, "b-text", "a", "before"), 409);
    await fail(moveElement(html, "gone", "a", "before"), 404);
    await fail(moveElement(html, "a", "a", "before"), 400);
    await fail(moveElement("<ul><li data-oid='x'>1<li data-oid='y'>2</ul>", "x", "y", "after"), 409);
    await fail(moveElement('<p data-oid="d">1</p><p data-oid="d">2</p><p data-oid="e"></p>', "d", "e", "after"), 409);
  });

  test("implied end tags do not make the next element a child", async () => {
    // <p> is closed by <section>, so both are children of body.
    const out = await moveElement('<p data-oid="p">text<section data-oid="s">S</section>', "s", "p", "before");
    expect(out).toBe('<section data-oid="s">S</section><p data-oid="p">text');
  });
});

describe("spacing scale", () => {
  test("from --space variables, in px, sorted, design first", () => {
    const design = ":root { --space-2: 8px; --space-1: 0.25rem; --gap: 24px; --radius: 6px; }";
    const ds = ":root { --spacing-sm: 8px; --spacing-lg: 2rem; }";
    expect(spacingScale([design, ds])).toEqual({
      unit: 4,
      steps: [
        { px: 0, var: null },
        { px: 4, var: "--space-1" },
        { px: 8, var: "--space-2" },
        { px: 24, var: "--gap" },
        { px: 32, var: "--spacing-lg" },
      ],
    });
  });

  test("a 4 px scale without variables", () => {
    const s = spacingScale([":root { --radius: 4px; }"]);
    expect(s.unit).toBe(4);
    expect(s.steps.map((x) => x.px)).toEqual([0, 4, 8, 12, 16, 24, 32, 48, 64, 96]);
  });
});

describe("edit routes", () => {
  const params = { project: "p", design: "d" };
  const post = (body: unknown) => new Request("http://x/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const setup = async () => {
    const ws = await mkdtemp(join(tmpdir(), "doi-edit-"));
    await ensureRepo(ws);
    const dir = designDir(ws, "p", "d");
    await Bun.write(join(dir, "index.html"), '<main data-oid="m">\n  <h1 data-oid="t">T</h1>\n  <p data-oid="x">X</p>\n</main>\n');
    await Bun.write(join(dir, "styles.css"), ":root { --space-1: 4px; --space-2: 8px; }\n");
    await commitPaths(ws, [dir], "Start");
    const deps = { workspace: ws, locks: new DesignLocks(), variantsOpen: async () => false, commit: (p: string[], m: string) => commitPaths(ws, p, m) };
    return { ws, dir, deps };
  };

  test("a style edit writes the rule and commits; undo puts the file back as a new version", async () => {
    const { ws, dir, deps } = await setup();
    const res = await postEdit(deps, post({ oid: "t", style: { width: "320px" } }), params);
    expect(res.status).toBe(200);
    const { commit } = (await res.json()) as { commit: string };
    expect(await Bun.file(join(dir, "styles.css")).text()).toContain('[data-oid="t"] {\n  width: 320px;\n}');
    expect((await designLog(ws, "p", "d"))[0]!.message).toBe("Edit t: width 320px");

    const undo = await undoEdit(deps, post({ commit }), params);
    expect(undo.status).toBe(200);
    expect(await Bun.file(join(dir, "styles.css")).text()).toBe(":root { --space-1: 4px; --space-2: 8px; }\n");
    expect((await designLog(ws, "p", "d")).map((v) => v.message)).toEqual(["Undo Edit t: width 320px", "Edit t: width 320px", "Start"]);
    // The edit is no longer the newest version.
    expect((await undoEdit(deps, post({ commit }), params)).status).toBe(409);
  });

  test("a move changes the page and commits", async () => {
    const { ws, dir, deps } = await setup();
    const res = await postEdit(deps, post({ oid: "x", move: { target: "t", position: "before", page: "index.html" } }), params);
    expect(res.status).toBe(200);
    expect(await Bun.file(join(dir, "index.html")).text()).toBe('<main data-oid="m">\n  <p data-oid="x">X</p>\n  <h1 data-oid="t">T</h1>\n</main>\n');
    expect((await designLog(ws, "p", "d"))[0]!.message).toBe("Edit x: move before t");
  });

  test("bad bodies, locks, open variants and turns that are not edits", async () => {
    const { deps } = await setup();
    expect((await postEdit(deps, post({ oid: "t" }), params)).status).toBe(400);
    expect((await postEdit(deps, post({ oid: "t", style: { color: "red" } }), params)).status).toBe(400);
    expect((await postEdit(deps, post({ oid: "t", move: { target: "x", position: "inside" } }), params)).status).toBe(400);
    expect((await postEdit(deps, post({ oid: "t", move: { target: "x", position: "after", page: "../x.html" } }), params)).status).toBe(404);
    expect((await postEdit(deps, post({ oid: "t", style: { width: "1px" } }), { project: "p", design: "nope" })).status).toBe(404);
    expect((await postEdit({ ...deps, variantsOpen: async () => true }, post({ oid: "t", style: { width: "1px" } }), params)).status).toBe(409);
    deps.locks.tryLock("p/d");
    expect((await postEdit(deps, post({ oid: "t", style: { width: "1px" } }), params)).status).toBe(409);
    deps.locks.unlock("p/d");
    const [start] = await designLog(deps.workspace, "p", "d");
    expect((await undoEdit(deps, post({ commit: start!.sha }), params)).status).toBe(409);
  });

  test("GET spacing reads the design's variables", async () => {
    const { ws } = await setup();
    const scale = (await (await getSpacing(ws, params)).json()) as { unit: number; steps: { px: number }[] };
    expect(scale.unit).toBe(4);
    expect(scale.steps.map((s) => s.px)).toEqual([0, 4, 8]);
  });
});
