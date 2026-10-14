import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTweaks, putTweaks } from "../src/server/tweaks.ts";
import { DesignLocks } from "../src/server/locks.ts";
import { checkVars, deriveControls, parseTweaksJson, withVars } from "../src/workspace/tweaks.ts";
import { designDir } from "../src/workspace/paths.ts";

const CSS = `:root {
  --accent: #3d4ed8;
  --radius: 16px;
  --gap: 1.5rem;
  --font: system-ui, sans-serif;
}
@media (min-width: 700px) { :root { --gap: 2rem; } }
.card { border-radius: var(--radius); }
`;

describe("tweak controls", () => {
  test("derived from the :root variables: colors and numbers with units", () => {
    const vars = new Map([["--accent", "#3d4ed8"], ["--radius", "16px"], ["--gap", "1.5rem"], ["--font", "system-ui"], ["--soft", "oklch(0.9 0.03 190)"]]);
    expect(deriveControls(vars)).toEqual([
      { var: "--accent", type: "color", value: "#3d4ed8" },
      { var: "--radius", type: "slider", value: "16px", min: 0, max: 32, step: 1, unit: "px" },
      { var: "--gap", type: "slider", value: "1.5rem", min: 0, max: 4, step: 0.05, unit: "rem" },
      { var: "--soft", type: "color", value: "oklch(0.9 0.03 190)" },
    ]);
  });

  test("tweaks.json: only controls for existing variables, with their values now", () => {
    const vars = new Map([["--accent", "#000"], ["--radius", "8px"], ["--dir", "row"]]);
    const controls = parseTweaksJson(
      {
        controls: [
          { var: "--accent", type: "color" },
          { var: "--radius", type: "slider", min: 0, max: 24, step: 2, unit: "px" },
          { var: "--dir", type: "select", options: ["column"] },
          { var: "--gone", type: "color" },
          { var: "accent", type: "color" },
          { var: "--dir", type: "dial" },
        ],
      },
      vars,
    );
    expect(controls).toEqual([
      { var: "--accent", type: "color", value: "#000" },
      { var: "--radius", type: "slider", value: "8px", min: 0, max: 24, step: 2, unit: "px" },
      { var: "--dir", type: "select", value: "row", options: ["row", "column"] },
    ]);
    expect(parseTweaksJson({ nope: 1 }, vars)).toEqual([]);
  });
});

describe("writing tweaks", () => {
  test("changes the top-level :root declarations only; a media query keeps its value", () => {
    const out = withVars(CSS, { "--accent": "#c00", "--gap": "3rem" });
    expect(out).toContain("  --accent: #c00;\n  --radius: 16px;\n  --gap: 3rem;");
    expect(out).toContain("@media (min-width: 700px) { :root { --gap: 2rem; } }");
    expect(out).toContain(".card { border-radius: var(--radius); }");
  });

  test("a variable that is not on :root is an error, and nothing is half written", () => {
    expect(() => withVars(CSS, { "--accent": "red", "--nope": "1px" })).toThrow("Not on :root in styles.css: --nope.");
  });

  test("values are checked", () => {
    expect(checkVars({ "--a": " 4px " })).toEqual({ "--a": "4px" });
    for (const bad of [{ a: "1" }, { "--a": "red; } body { color: red" }, { "--a": "" }, { "--a": 3 }, {}, [], null]) {
      expect(() => checkVars(bad)).toThrow();
    }
  });
});

describe("tweak routes", () => {
  const setup = async () => {
    const ws = await mkdtemp(join(tmpdir(), "doi-tweaks-"));
    const dir = designDir(ws, "p", "d");
    await Bun.write(join(dir, "index.html"), '<link rel="stylesheet" href="styles.css">');
    await Bun.write(join(dir, "styles.css"), CSS);
    return { ws, dir };
  };
  const put = (vars: unknown) => new Request("http://x/", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ vars }) });

  test("GET lists the controls; PUT writes styles.css and commits", async () => {
    const { ws, dir } = await setup();
    const got = (await (await getTweaks(ws, { project: "p", design: "d" })).json()) as { source: string; controls: { var: string }[] };
    expect(got.source).toBe("styles.css");
    expect(got.controls.map((c) => c.var)).toEqual(["--accent", "--radius", "--gap"]);
    const commits: string[] = [];
    const deps = { workspace: ws, locks: new DesignLocks(), commit: async (_p: string[], m: string) => (commits.push(m), "abc1234") };
    const res = await putTweaks(deps, put({ "--radius": "4px" }), { project: "p", design: "d" });
    expect(res.status).toBe(200);
    expect(await Bun.file(join(dir, "styles.css")).text()).toContain("--radius: 4px;");
    expect(commits).toEqual(["Tweaks: --radius"]);
  });

  test("PUT waits for a running turn, and refuses unknown variables", async () => {
    const { ws } = await setup();
    const locks = new DesignLocks();
    const deps = { workspace: ws, locks, commit: async () => null };
    locks.tryLock("p/d");
    expect((await putTweaks(deps, put({ "--radius": "4px" }), { project: "p", design: "d" })).status).toBe(409);
    locks.unlock("p/d");
    expect((await putTweaks(deps, put({ "--nope": "4px" }), { project: "p", design: "d" })).status).toBe(409);
    expect((await putTweaks(deps, put({ "--radius": "4px" }), { project: "p", design: "missing" })).status).toBe(404);
  });
});
