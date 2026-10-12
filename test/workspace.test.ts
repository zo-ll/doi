import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { designFile, ensureWorkspace } from "../src/workspace/paths.ts";

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

describe("designFile", () => {
  test("resolves files inside the design folder", () => {
    expect(designFile("/ws", "sample", "home", "styles.css")).toBe("/ws/projects/sample/designs/home/styles.css");
  });

  test("blocks paths that leave the design folder", () => {
    expect(designFile("/ws", "sample", "home", "../other/index.html")).toBeNull();
    expect(designFile("/ws", "sample", "home", "../../../../etc/passwd")).toBeNull();
  });

  test("rejects invalid names", () => {
    expect(() => designFile("/ws", "..", "home", "index.html")).toThrow("Invalid project name");
  });
});

describe("ensureWorkspace", () => {
  test("creates a sample design with data-oid ids, and keeps edits on a second run", async () => {
    const ws = await mkdtemp(join(tmpdir(), "doi-"));
    dirs.push(ws);
    await ensureWorkspace(ws);
    const index = join(ws, "projects/sample/designs/home/index.html");
    expect(await Bun.file(index).text()).toContain('data-oid="title"');

    await Bun.write(index, "edited");
    await ensureWorkspace(ws);
    expect(await Bun.file(index).text()).toBe("edited");
  });
});
