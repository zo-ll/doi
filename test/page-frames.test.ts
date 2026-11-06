import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { designFrames, writeLayout } from "../src/workspace/layout.ts";
import { defaultLayout, flowFrames, FRAME_GAP, FRAME_LIMITS, parseLayout, shownPages, viewportFrames, type ScreenFrame } from "../src/workspace/frames.ts";

const PAGES = ["index.html", "02-signup.html", "03-dashboard.html"];
const added: ScreenFrame = { id: "phone", label: "Phone", width: 390, height: 844, x: 9000, y: 0 };

test("one page keeps the stored frames, or the default layout", () => {
  expect(flowFrames(defaultLayout(), ["index.html"])).toEqual(defaultLayout());
  expect(flowFrames([added], ["index.html"])).toEqual([added]);
  // The design had several pages: the page frames go with them.
  expect(flowFrames([{ ...added, id: "page-index", page: "index.html" }], ["index.html"])).toEqual(defaultLayout());
  expect(flowFrames(defaultLayout(), [])).toEqual(defaultLayout());
});

test("several pages give one Desktop frame per page, in page order, without the default frames", () => {
  const frames = flowFrames(defaultLayout(), PAGES);
  expect(frames.map((f) => f.page)).toEqual(PAGES);
  expect(frames.map((f) => f.label)).toEqual(["index", "02-signup", "03-dashboard"]);
  expect(frames.map((f) => f.width)).toEqual([1440, 1440, 1440]);
  expect(frames.map((f) => f.x)).toEqual([0, 1440 + FRAME_GAP, 2 * (1440 + FRAME_GAP)]);
  expect(new Set(frames.map((f) => f.id)).size).toBe(3);
  expect(parseLayout(frames)).toEqual(frames);
});

test("a stored page frame keeps its place, a new page goes to the right, a gone page goes", () => {
  const first = flowFrames(defaultLayout(), PAGES);
  const moved = first.map((f) => (f.page === "02-signup.html" ? { ...f, x: 5000, y: 700 } : f));
  const next = flowFrames(moved, ["index.html", "02-signup.html", "04-new.html"]);
  expect(next.map((f) => f.page)).toEqual(["index.html", "02-signup.html", "04-new.html"]);
  expect(next[1]).toMatchObject({ x: 5000, y: 700 });
  expect(next[2]!.x).toBe(5000 + 1440 + FRAME_GAP);
});

test("a frame the user added stays after the page frames, also with a default id", () => {
  const start = flowFrames([...defaultLayout(), added], PAGES);
  expect(start.at(-1)).toEqual(added);
  // Once the design has page frames, a frame named "mobile" is one the user added.
  const mobile = { ...added, id: "mobile" };
  const next = flowFrames([...start, mobile], PAGES);
  expect(next.map((f) => f.id)).toContain("mobile");
});

test("the frame limit holds, and page frames come first", () => {
  const many = Array.from({ length: 15 }, (_, i) => `p${i}.html`);
  const frames = flowFrames([added], many);
  expect(frames).toHaveLength(FRAME_LIMITS.count);
  expect(frames.every((f) => f.page)).toBe(true);
  expect(typeof parseLayout(frames)).not.toBe("string");
});

test("the open page always has a frame", () => {
  const many = Array.from({ length: 15 }, (_, i) => `p${i}.html`);
  expect(shownPages(many, "p1.html")).toEqual(many.slice(0, 12));
  const open = shownPages(many, "p14.html");
  expect(open).toHaveLength(12);
  expect(open.at(-1)).toBe("p14.html");
  expect(shownPages(many, "gone.html")).toEqual(many.slice(0, 12));
});

test("page frames count as one Desktop viewport for export, the handoff and MCP", () => {
  expect(viewportFrames(defaultLayout())).toEqual(defaultLayout());
  const frames = flowFrames([...defaultLayout(), added], PAGES);
  expect(viewportFrames(frames).map((f) => f.id)).toEqual(["desktop", "phone"]);
  expect(viewportFrames(frames).every((f) => !("page" in f))).toBe(true);
  expect(viewportFrames(frames.filter((f) => f.page)).map((f) => [f.id, f.width])).toEqual([["desktop", 1440]]);
  // An added frame named "desktop" is that viewport.
  const named = [{ ...added, id: "desktop" }, ...frames.filter((f) => f.page)];
  expect(viewportFrames(named).map((f) => f.width)).toEqual([390]);
});

test("MCP lists viewports, not page frames", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "doi-page-frames-"));
  try {
    await mkdir(join(workspace, "projects/p"), { recursive: true });
    await writeLayout(workspace, "p", "d", flowFrames(defaultLayout(), PAGES));
    expect((await designFrames(workspace, "p", "d")).map((f) => f.id)).toEqual(["desktop"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a stored frame's page must be a page name", () => {
  const base = { id: "a", label: "A", width: 400, height: 400, x: 0, y: 0 };
  expect(parseLayout([{ ...base, page: "a.html" }])).toEqual([{ ...base, page: "a.html" }]);
  for (const page of [7, "", "x".repeat(201)]) expect(typeof parseLayout([{ ...base, page }])).toBe("string");
});
