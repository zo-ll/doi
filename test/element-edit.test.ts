import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

  test("a nested rule stops the edit; a comment in the rule is not a declaration", () => {
    const nested = '[data-oid="a"] { color: red; & .child { width: 5px; } }';
    expect(() => withElementStyle(nested, "a", { width: "300px" })).toThrow(/nested rules/);
    const commented = '[data-oid="a"] { color: red; /* note; width: 999px; */ }';
    expect(withElementStyle(commented, "a", { width: "20px" })).toBe('[data-oid="a"] { color: red; /* note; width: 999px; */\n  width: 20px;\n}');
    const after = '[data-oid="a"] {\n  /* old: width: 1px; */\n  width: 10px;\n}\n';
    expect(withElementStyle(after, "a", { width: "12px" })).toBe('[data-oid="a"] {\n  /* old: width: 1px; */\n  width: 12px;\n}\n');
    expect(withElementStyle(after, "a", { width: null })).toBe('[data-oid="a"] {\n  /* old: width: 1px; */\n}\n');
  });

  test("braces and semicolons in strings do not count, in the rule and before it", () => {
    expect(withElementStyle('[data-oid="a"] { content: "{"; width: 1px; }', "a", { width: "9px" })).toBe('[data-oid="a"] { content: "{"; width: 9px; }');
    const css = '.q::after { content: "}"; }\n[data-oid="a"] { content: "};"; width: 1px; }\n[data-oid="b"] { width: 2px; }\n';
    expect(withElementStyle(css, "a", { width: "9px" })).toBe('.q::after { content: "}"; }\n[data-oid="a"] { content: "};"; width: 9px; }\n[data-oid="b"] { width: 2px; }\n');
    expect(withElementStyle("[data-oid='a'] { width: 1px; }", "a", { width: "2px" })).toContain('\n[data-oid="a"] {\n  width: 2px;\n}\n');
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

  test("an element or a target without its own end tag cannot move; nothing leaves its parent", async () => {
    const cases: [string, string, string, "before" | "after"][] = [
      ["<div><span data-oid='t'>T</span><p data-oid='x'>a</div>", "x", "t", "before"],
      ["<ul><li data-oid='t'>T</li><li data-oid='x'>X</ul>", "x", "t", "before"],
      ["<main><p data-oid='x'>a<p data-oid='t'>b</p></main>", "x", "t", "after"],
      ["<main><b data-oid='x'>x</b><p data-oid='t'>a</main>", "x", "t", "after"],
    ];
    for (const [page, oid, target, position] of cases) {
      const e = await moveElement(page, oid, target, position).catch((x) => x);
      expect(e).toBeInstanceOf(EditError);
      expect(e.status).toBe(409);
    }
    // With the end tags in place, the same move works.
    expect(await moveElement("<main><p data-oid='t'>a<b data-oid='x'>x</b></main>".replace("<b", "</p><b"), "x", "t", "before")).toBe(
      "<main><b data-oid='x'>x</b><p data-oid='t'>a</p></main>",
    );
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
  // A test identity in a private global config, as in git.test.ts: CI has none.
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  beforeAll(async () => {
    const home = await mkdtemp(join(tmpdir(), "doi-gitcfg-"));
    await Bun.write(join(home, "gitconfig"), "[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
    process.env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
  });
  afterAll(() => {
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
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

  test("an edit commits only its file; undo leaves other changes in the folder alone", async () => {
    const { ws, dir, deps } = await setup();
    await Bun.write(join(dir, "draft.html"), "<p>by hand</p>");
    const { commit } = (await (await postEdit(deps, post({ oid: "t", style: { height: "40px" } }), params)).json()) as { commit: string };
    expect((await Bun.$`git -C ${ws} show --name-only --format= ${commit}`.text()).trim()).toBe("projects/p/designs/d/styles.css");
    expect((await undoEdit(deps, post({ commit }), params)).status).toBe(200);
    expect(await Bun.file(join(dir, "draft.html")).text()).toBe("<p>by hand</p>");
    expect(await Bun.file(join(dir, "styles.css")).text()).toBe(":root { --space-1: 4px; --space-2: 8px; }\n");
  });

  test("undo restores a file with a non-ASCII name", async () => {
    const { ws, dir, deps } = await setup();
    await Bun.write(join(dir, "über.html"), '<main data-oid="m">\n  <h1 data-oid="u1">1</h1>\n  <p data-oid="u2">2</p>\n</main>\n');
    await commitPaths(ws, [dir], "Add über");
    const before = await Bun.file(join(dir, "über.html")).text();
    const res = await postEdit(deps, post({ oid: "u2", move: { target: "u1", position: "before", page: "über.html" } }), params);
    const { commit } = (await res.json()) as { commit: string };
    expect(await Bun.file(join(dir, "über.html")).text()).not.toBe(before);
    expect((await (await undoEdit(deps, post({ commit }), params)).json()) as object).toMatchObject({ commit: expect.any(String) });
    expect(await Bun.file(join(dir, "über.html")).text()).toBe(before);
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
