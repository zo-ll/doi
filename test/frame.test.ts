import { describe, expect, test } from "bun:test";
import { parseFrameMessage, trackMessage } from "../src/web/frame.ts";

const r = { x: 1, y: 2, width: 30, height: 40 };

describe("frame messages", () => {
  test("valid messages pass", () => {
    expect(parseFrameMessage({ type: "doi:ready" })).toEqual({ type: "doi:ready" });
    expect(parseFrameMessage({ type: "doi:clear", extra: 1 })).toEqual({ type: "doi:clear" });
    expect(parseFrameMessage({ type: "doi:select", oid: "signup-button" })).toEqual({ type: "doi:select", oid: "signup-button" });
    expect(parseFrameMessage({ type: "doi:rects", selected: r, hover: { oid: "a", rect: r } })).toEqual({
      type: "doi:rects",
      selected: r,
      hover: { oid: "a", rect: r },
    });
    expect(parseFrameMessage({ type: "doi:rects", selected: null, hover: null })).toEqual({ type: "doi:rects", selected: null, hover: null });
  });

  test("a select with an id the server would refuse is dropped", () => {
    for (const oid of ["", "my para", "x".repeat(101), 5, null, undefined]) {
      expect(parseFrameMessage({ type: "doi:select", oid })).toBeNull();
    }
  });

  test("bad rects are dropped; a bad hover only hides the hover", () => {
    for (const selected of [{ ...r, x: NaN }, { ...r, width: -1 }, { x: 1 }, "rect", undefined]) {
      expect(parseFrameMessage({ type: "doi:rects", selected, hover: null })).toBeNull();
    }
    expect(parseFrameMessage({ type: "doi:rects", selected: r, hover: { oid: "bad id", rect: r } })).toEqual({
      type: "doi:rects",
      selected: r,
      hover: null,
    });
    expect(parseFrameMessage({ type: "doi:rects", selected: r, hover: { oid: "a", rect: { x: Infinity } } })).toMatchObject({ hover: null });
  });

  test("other data is not a frame message", () => {
    for (const data of [null, "doi:select", 1, {}, { type: "doi:other" }, { type: "webpackOk" }]) {
      expect(parseFrameMessage(data)).toBeNull();
    }
  });

  test("track names the selected element or null", () => {
    expect(trackMessage("a")).toEqual({ type: "doi:track", oid: "a" });
    expect(trackMessage(null)).toEqual({ type: "doi:track", oid: null });
  });
});
