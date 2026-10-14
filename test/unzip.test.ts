import { expect, test } from "bun:test";
import { safeZipPath, unzip } from "../src/export/unzip.ts";
import { zip } from "../src/export/zip.ts";

const enc = new TextEncoder();
const file = (path: string, text: string) => ({ path, data: enc.encode(text) as Uint8Array<ArrayBuffer> });

test("reads back what zip() writes: stored and deflated files", () => {
  const big = "a".repeat(10_000);
  const out = unzip(zip([file("manifest.json", "{}"), file("files/projects/p/designs/d/index.html", big), file("x/é.txt", "é")]));
  expect(out.map((e) => [e.path, new TextDecoder().decode(e.data).length])).toEqual([
    ["manifest.json", 2],
    ["files/projects/p/designs/d/index.html", 10_000],
    ["x/é.txt", 1],
  ]);
});

test("unsafe names", () => {
  for (const bad of ["/etc/passwd", "../x", "a/../b", "a\\b", "a//b", "./a", ""]) expect(safeZipPath(bad)).toBe(false);
  for (const ok of ["a", "a/b.c", "files/.comments.json", "a..b/c"]) expect(safeZipPath(ok)).toBe(true);
});

test("a path that leaves the folder, a broken file and a bad CRC are refused", () => {
  const evil = zip([file("../../evil.sh", "x")]);
  expect(() => unzip(evil)).toThrow("unsafe path");
  expect(() => unzip(enc.encode("not a zip at all, sorry"))).toThrow("not a ZIP file");
  const good = zip([file("a.txt", "hello hello hello hello hello hello")]);
  const broken = good.slice();
  broken[40] = broken[40]! ^ 0xff; // a byte of the deflated data
  expect(() => unzip(broken)).toThrow();
});

test("a file larger than its declared size is refused before it fills the memory", () => {
  const archive = zip([file("bomb.txt", "0".repeat(1_000_000))]);
  const view = new DataView(archive.buffer);
  // Declare 10 bytes in the central directory (offset of the entry's uncompressed size).
  const eocd = archive.length - 22;
  const dir = view.getUint32(eocd + 16, true);
  view.setUint32(dir + 24, 10, true);
  expect(() => unzip(archive)).toThrow();
});
