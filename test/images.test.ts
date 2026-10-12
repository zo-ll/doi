import { describe, expect, test } from "bun:test";
import { fitWithin, isImageType } from "../src/web/images.ts";
import { uploadFile } from "../src/workspace/uploads.ts";

describe("images", () => {
  test("fitWithin scales the long edge down and never up", () => {
    expect(fitWithin(3136, 1000, 1568)).toEqual({ width: 1568, height: 500 });
    expect(fitWithin(1000, 4000, 1568)).toEqual({ width: 392, height: 1568 });
    expect(fitWithin(800, 600, 1568)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(100_000, 1, 1568)).toEqual({ width: 1568, height: 1 });
  });

  test("only the four common image types", () => {
    expect(["image/png", "image/jpeg", "image/webp", "image/gif"].every(isImageType)).toBe(true);
    expect(isImageType("image/svg+xml")).toBe(false);
  });

  test("upload names cannot leave the uploads folder", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(uploadFile("/ws", "p", `${id}-0.png`)).toBe(`/ws/projects/p/uploads/${id}-0.png`);
    for (const bad of ["../chat.jsonl", `${id}-0.svg`, `../${id}-0.png`, "a.png", `${id}-10.png`]) {
      expect(uploadFile("/ws", "p", bad)).toBeNull();
    }
    expect(() => uploadFile("/ws", "../x", `${id}-0.png`)).toThrow();
  });
});
