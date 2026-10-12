import { describe, expect, test } from "bun:test";
import { defaultLayout, type Frame } from "../src/workspace/frames.ts";
import { arrangeRow, boundsOf, fitView, newFrameId, nextPosition, stepZoom, wheelFactor, zoomAt, ZOOM_MAX, ZOOM_MIN } from "../src/web/viewport.ts";

const f = (id: string, x: number, y: number, width = 100, height = 100): Frame => ({ id, label: id, width, height, x, y });

describe("viewport", () => {
  test("zoomAt keeps the point under the cursor in place", () => {
    const v = { x: 30, y: 40, zoom: 0.5 };
    const at = { x: 200, y: 100 };
    const world = { x: (at.x - v.x) / v.zoom, y: (at.y - v.y) / v.zoom };
    const z = zoomAt(v, 2, at);
    expect(z.zoom).toBe(2);
    expect(world.x * z.zoom + z.x).toBeCloseTo(at.x);
    expect(world.y * z.zoom + z.y).toBeCloseTo(at.y);
    expect(zoomAt(v, 100, at).zoom).toBe(ZOOM_MAX);
    expect(zoomAt(v, 0, at).zoom).toBe(ZOOM_MIN);
  });

  test("zoom steps and wheel factors", () => {
    expect(stepZoom(0.4, 1)).toBe(0.5);
    expect(stepZoom(0.4, -1)).toBe(0.33);
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
    expect(wheelFactor(0)).toBe(1);
    expect(wheelFactor(-10)).toBeGreaterThan(1);
    expect(wheelFactor(1000)).toBeCloseTo(Math.exp(-0.25));
  });

  test("fit shows all frames with their labels, centered, at most 100%", () => {
    const frames = defaultLayout();
    const size = { width: 1000, height: 800 };
    const v = fitView(frames, size);
    const b = boundsOf(frames)!;
    const left = b.x * v.zoom + v.x;
    const right = (b.x + b.width) * v.zoom + v.x;
    expect(left).toBeCloseTo(size.width - right); // centered
    expect(left).toBeGreaterThanOrEqual(48 - 1e-9);
    expect((b.y + b.height) * v.zoom + v.y).toBeLessThanOrEqual(size.height);
    expect(fitView([f("a", 0, 0, 200, 200)], size).zoom).toBe(1);
    expect(fitView([], size)).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  test("new frames go right of the others; arrange puts them in a row in order", () => {
    expect(nextPosition([])).toEqual({ x: 0, y: 0 });
    expect(nextPosition([f("a", 0, 50, 300), f("b", 500, 10, 100)])).toEqual({ x: 680, y: 10 });
    expect(arrangeRow([f("b", 900, 300), f("a", -50, 20, 200)]).map((x) => [x.id, x.x, x.y])).toEqual([
      ["b", 280, 0],
      ["a", 0, 0],
    ]);
  });

  test("frame ids come from the label and stay unique", () => {
    expect(newFrameId([], "Tablet")).toBe("tablet");
    expect(newFrameId([f("tablet", 0, 0), f("tablet-2", 0, 0)], "Tablet")).toBe("tablet-3");
    expect(newFrameId([], "1280 × 720")).toBe("1280-720");
    expect(newFrameId([], "!!")).toBe("frame");
  });
});

test("variant frames go in one row under the design frames, with the size of the first frame", async () => {
  const { variantSlots } = await import("../src/web/viewport.ts");
  expect(variantSlots([f("a", 10, 0, 1000, 600), f("b", 1100, 50, 300, 700)], 2)).toEqual([
    { x: 10, y: 990, width: 1000, height: 600 },
    { x: 1090, y: 990, width: 1000, height: 600 },
  ]);
  expect(variantSlots([], 1)).toEqual([{ x: 0, y: 0, width: 1440, height: 900 }]);
});
