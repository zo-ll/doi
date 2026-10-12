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
      pins: {},
    });
    expect(parseFrameMessage({ type: "doi:rects", selected: null, hover: null })).toEqual({ type: "doi:rects", selected: null, hover: null, pins: {} });
    expect(parseFrameMessage({ type: "doi:rects", selected: null, hover: null, pins: { a: r, b: r } })).toMatchObject({ pins: { a: r, b: r } });
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
      pins: {},
    });
    expect(parseFrameMessage({ type: "doi:rects", selected: r, hover: { oid: "a", rect: { x: Infinity } } })).toMatchObject({ hover: null });
    // A bad pin is left out; the good ones stay.
    expect(parseFrameMessage({ type: "doi:rects", selected: r, hover: null, pins: { "bad id": r, a: { x: 1 }, b: r } })).toMatchObject({ pins: { b: r } });
    expect(parseFrameMessage({ type: "doi:rects", selected: r, hover: null, pins: "x" })).toMatchObject({ pins: {} });
    // structuredClone keeps "__proto__" as an own key, as postMessage does.
    const m = parseFrameMessage(structuredClone({ type: "doi:rects", selected: null, hover: null, pins: JSON.parse(`{"__proto__": ${JSON.stringify(r)}}`) }));
    expect(m?.type === "doi:rects" && Object.keys(m.pins)).toEqual(["__proto__"]);
    expect(m?.type === "doi:rects" && Object.getPrototypeOf(m.pins)).toBeNull();
  });

  test("wheel and key messages pass only with good values and canvas keys", () => {
    expect(parseFrameMessage({ type: "doi:wheel", deltaY: -3, x: 10, y: 20 })).toEqual({ type: "doi:wheel", deltaY: -3, x: 10, y: 20 });
    expect(parseFrameMessage({ type: "doi:wheel", deltaY: "1", x: 10, y: 20 })).toBeNull();
    expect(parseFrameMessage({ type: "doi:wheel", deltaY: Infinity, x: 10, y: 20 })).toBeNull();
    expect(parseFrameMessage({ type: "doi:key", key: "=", down: true, shift: false, mod: true })).toEqual({
      type: "doi:key",
      key: "=",
      down: true,
      shift: false,
      mod: true,
    });
    expect(parseFrameMessage({ type: "doi:key", key: " ", down: "yes" })).toEqual({ type: "doi:key", key: " ", down: false, shift: false, mod: false });
    for (const key of ["a", "Enter", "Tab", 1]) expect(parseFrameMessage({ type: "doi:key", key, down: true })).toBeNull();
  });

  test("other data is not a frame message", () => {
    for (const data of [null, "doi:select", 1, {}, { type: "doi:other" }, { type: "webpackOk" }]) {
      expect(parseFrameMessage(data)).toBeNull();
    }
  });

  test("track names the selected element or null", () => {
    expect(trackMessage("a")).toEqual({ type: "doi:track", oid: "a", pins: [] });
    expect(trackMessage(null, ["b", "c"])).toEqual({ type: "doi:track", oid: null, pins: ["b", "c"] });
  });
});
