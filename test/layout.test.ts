import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLayout, putLayout } from "../src/server/layout.ts";
import { defaultLayout, parseLayout, readLayout, renameLayout, writeLayout, type Frame } from "../src/workspace/layout.ts";
import { projectFile } from "../src/workspace/project-file.ts";
import { renameProject } from "../src/workspace/projects.ts";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "doi-layout-"));
  await mkdir(join(ws, "projects", "p", "designs", "d"), { recursive: true });
  await Bun.write(projectFile(ws, "p"), JSON.stringify({ name: "P", designSystem: null }));
});

const frame = (over: Partial<Frame> = {}): Frame => ({ id: "f1", label: "Tablet", width: 768, height: 1024, x: 0, y: 0, ...over });

describe("frame layout", () => {
  test("a design without a stored layout gets desktop and mobile side by side", async () => {
    expect(await readLayout(ws, "p", "d")).toEqual(defaultLayout());
    expect(defaultLayout().map((f) => [f.width, f.x])).toEqual([[1440, 0], [390, 1520]]);
  });

  test("a layout is stored per design in project.json, next to the other fields", async () => {
    await writeLayout(ws, "p", "d", [frame()]);
    await writeLayout(ws, "p", "e", [frame({ id: "x" })]);
    expect(await readLayout(ws, "p", "d")).toEqual([frame()]);
    const meta = await Bun.file(projectFile(ws, "p")).json();
    expect(meta).toEqual({ name: "P", designSystem: null, layouts: { d: [frame()], e: [frame({ id: "x" })] } });
  });

  test("a rename of the project and a layout change at the same time both stay", async () => {
    await Promise.all([
      renameProject(ws, "p", "New name"),
      writeLayout(ws, "p", "d", [frame()]),
      ...Array.from({ length: 10 }, (_, i) => writeLayout(ws, "p", `d${i}`, [frame()])),
    ]);
    const meta = await Bun.file(projectFile(ws, "p")).json();
    expect(meta.name).toBe("New name");
    expect(Object.keys(meta.layouts).sort()).toEqual(["d", ...Array.from({ length: 10 }, (_, i) => `d${i}`)].sort());
  });

  test("a renamed design keeps its layout", async () => {
    await writeLayout(ws, "p", "d", [frame()]);
    await renameLayout(ws, "p", "d", "e");
    expect(await readLayout(ws, "p", "e")).toEqual([frame()]);
    expect(await readLayout(ws, "p", "d")).toEqual(defaultLayout());
    await renameLayout(ws, "p", "none", "other"); // no layout: no change
    expect(Object.keys((await Bun.file(projectFile(ws, "p")).json()).layouts)).toEqual(["e"]);
  });

  test("a bad stored layout gives the default layout", async () => {
    await Bun.write(projectFile(ws, "p"), JSON.stringify({ name: "P", layouts: { d: [{ id: "x" }] } }));
    expect(await readLayout(ws, "p", "d")).toEqual(defaultLayout());
  });

  test("a write to a project that is gone fails and makes no folder", async () => {
    await rm(join(ws, "projects", "p"), { recursive: true });
    expect(writeLayout(ws, "p", "d", [frame()])).rejects.toThrow();
    expect(await Bun.file(projectFile(ws, "p")).exists()).toBe(false);
  });

  test("parseLayout checks each field", () => {
    expect(parseLayout([frame(), frame({ id: "f2", x: 900 })])).toEqual([frame(), frame({ id: "f2", x: 900 })]);
    const bad: unknown[] = [
      "x",
      [],
      Array.from({ length: 13 }, (_, i) => frame({ id: `f${i}` })),
      [frame(), frame()],
      [frame({ id: "Bad Id" })],
      [frame({ label: " " })],
      [frame({ label: "x".repeat(41) })],
      [frame({ width: 199 })],
      [frame({ width: 3841 })],
      [frame({ height: 4001 })],
      [frame({ width: 300.5 })],
      [frame({ x: 100_001 })],
      [frame({ y: Number.NaN })],
      [null],
    ];
    for (const b of bad) expect(typeof parseLayout(b)).toBe("string");
  });
});

describe("layout API", () => {
  const params = { project: "p", design: "d" };
  const put = (body: unknown, p = params) => putLayout(ws, new Request("http://x/", { method: "PUT", body: JSON.stringify(body) }), p);

  test("GET gives the default, PUT stores, bad input and unknown designs are refused", async () => {
    await Bun.write(join(ws, "projects", "p", "designs", "d", "index.html"), "<main></main>");
    expect(await (await getLayout(ws, params)).json()).toEqual(defaultLayout());
    expect((await put({ frames: [frame()] })).status).toBe(200);
    expect(await (await getLayout(ws, params)).json()).toEqual([frame()]);
    const bad = await put({ frames: [] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("A design has 1 to 12 frames.");
    expect((await put("x")).status).toBe(400);
    expect((await put({ frames: [frame()] }, { project: "p", design: "nope" })).status).toBe(404);
    expect((await getLayout(ws, { project: "p", design: "../x" })).status).toBe(400);
  });
});
