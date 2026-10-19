import { describe, expect, test } from "bun:test";
import { alignStyle, DEFAULT_SCALE, dropTarget, nudgeStyle, resizeStyle, sameSpot, snapMargin, snapSize } from "../src/web/edit.ts";
import type { Layout } from "../src/web/frame.ts";

const scale = { unit: 4, steps: [{ px: 0, var: null }, { px: 4, var: "--space-1" }, { px: 8, var: "--space-2" }, { px: 16, var: "--space-4" }] };
const box = (x: number, y: number, width = 100, height = 40) => ({ x, y, width, height });
const base: Layout = { kind: "flow", direction: "column", margins: { top: 0, right: 0, bottom: 0, left: 0 }, extra: { x: 0, y: 0 }, siblings: [] };

describe("snapping", () => {
  test("sizes snap to the unit; margins to the nearest step, with its variable", () => {
    expect(snapSize(101, 4)).toBe(100);
    expect(snapSize(1, 4)).toBe(4);
    expect(snapMargin(7, scale)).toBe("var(--space-2)");
    expect(snapMargin(13, scale)).toBe("var(--space-4)");
    expect(snapMargin(1, scale)).toBe("0px");
    expect(snapMargin(-9, scale)).toBe("-8px");
    expect(snapMargin(30, DEFAULT_SCALE)).toBe("32px");
  });

  test("resize: each handle sets its sizes, without the padding of a content-box element", () => {
    expect(resizeStyle("e", box(0, 0), { x: 0, y: 0 }, 21, 50, 4)).toEqual({ width: "120px" });
    expect(resizeStyle("s", box(0, 0), { x: 0, y: 0 }, 21, 50, 4)).toEqual({ height: "92px" });
    expect(resizeStyle("se", box(0, 0), { x: 24, y: 16 }, 0, 0, 4)).toEqual({ width: "76px", height: "24px" });
  });

  test("nudge: only the moved axis, from the margins now", () => {
    expect(nudgeStyle({ ...base.margins, left: 8 }, 7, 0, scale)).toEqual({ "margin-left": "var(--space-4)" });
    expect(nudgeStyle(base.margins, 0, -5, scale)).toEqual({ "margin-top": "-4px" });
  });
});

describe("drop target", () => {
  const row: Layout = { ...base, kind: "flex", direction: "row", siblings: [{ oid: "a", rect: box(0, 0) }, { oid: "c", rect: box(220, 0) }] };

  test("nearest sibling, before or after along the axis", () => {
    expect(dropTarget(row, { x: 240, y: 20 })).toEqual({ target: "c", position: "before", line: { x: 219, y: 0, width: 2, height: 40 } });
    expect(dropTarget(row, { x: 90, y: 20 })).toMatchObject({ target: "a", position: "after" });
    const column: Layout = { ...base, siblings: [{ oid: "a", rect: box(0, 0) }] };
    expect(dropTarget(column, { x: 50, y: 35 })).toEqual({ target: "a", position: "after", line: { x: 0, y: 39, width: 100, height: 2 } });
    expect(dropTarget(base, { x: 0, y: 0 })).toBeNull();
  });

  test("a drop next to the element's own spot changes nothing", () => {
    const self = box(110, 0);
    expect(sameSpot(row, self, { target: "a", position: "after", line: self })).toBe(true);
    expect(sameSpot(row, self, { target: "c", position: "before", line: self })).toBe(true);
    expect(sameSpot(row, self, { target: "a", position: "before", line: self })).toBe(false);
    expect(sameSpot(row, self, { target: "c", position: "after", line: self })).toBe(false);
  });
});

describe("align", () => {
  test("flex: auto margins on the main axis, align-self across it", () => {
    const row: Layout = { ...base, kind: "flex", direction: "row" };
    expect(alignStyle(row, "x", "end")).toEqual({ "margin-left": "auto", "margin-right": "0px" });
    expect(alignStyle(row, "x", "center")).toEqual({ "margin-left": "auto", "margin-right": "auto" });
    expect(alignStyle(row, "y", "start")).toEqual({ "align-self": "flex-start" });
    const column: Layout = { ...row, direction: "column" };
    expect(alignStyle(column, "x", "center")).toEqual({ "align-self": "center" });
    expect(alignStyle(column, "y", "start")).toEqual({ "margin-top": "0px", "margin-bottom": "auto" });
  });

  test("grid uses justify-self and align-self; flow can align only on x", () => {
    const grid: Layout = { ...base, kind: "grid", direction: "grid" };
    expect(alignStyle(grid, "x", "end")).toEqual({ "justify-self": "end" });
    expect(alignStyle(grid, "y", "center")).toEqual({ "align-self": "center" });
    expect(alignStyle(base, "x", "start")).toEqual({ "margin-left": "0px", "margin-right": "auto" });
    expect(alignStyle(base, "y", "end")).toBeNull();
  });
});
