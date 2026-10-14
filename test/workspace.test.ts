import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { designFile, designPages, ensureWorkspace, listProjects } from "../src/workspace/paths.ts";

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

describe("listProjects", () => {
  test("lists projects with their designs, and skips folders without index.html", async () => {
    const ws = await mkdtemp(join(tmpdir(), "doi-"));
    dirs.push(ws);
    await ensureWorkspace(ws);
    await Bun.write(join(ws, "projects/sample/designs/empty/notes.txt"), "no index");
    await Bun.write(join(ws, "projects/other/designs/landing/index.html"), "<html></html>");

    expect(await listProjects(ws)).toEqual([
      { id: "other", name: "other", designs: ["landing"], decks: [], designSystem: null, repo: null },
      { id: "sample", name: "Sample", designs: ["home"], decks: [], designSystem: null, repo: null },
    ]);
  });

  test("falls back to the folder id when project.json is not valid JSON", async () => {
    const ws = await mkdtemp(join(tmpdir(), "doi-"));
    dirs.push(ws);
    await Bun.write(join(ws, "projects/broken/project.json"), "{ not json");
    await Bun.write(join(ws, "projects/broken/designs/home/index.html"), "<html></html>");

    expect(await listProjects(ws)).toEqual([{ id: "broken", name: "broken", designs: ["home"], decks: [], designSystem: null, repo: null }]);
  });

  test("returns an empty list for a missing workspace", async () => {
    expect(await listProjects("/nonexistent/doi-workspace")).toEqual([]);
  });
});

describe("design pages and slide decks", () => {
  test("lists HTML pages, index.html first, without hidden files", async () => {
    const ws = await mkdtemp(join(tmpdir(), "doi-"));
    dirs.push(ws);
    const dir = join(ws, "projects/p/designs/d");
    await Bun.write(join(dir, "index.html"), "<html></html>");
    await Bun.write(join(dir, "about.html"), "<html></html>");
    await Bun.write(join(dir, "blog/post.htm"), "<html></html>");
    await Bun.write(join(dir, ".old/x.html"), "<html></html>");
    await Bun.write(join(dir, "styles.css"), "");
    expect(await designPages(ws, "p", "d")).toEqual(["index.html", "about.html", "blog/post.htm"]);
  });

  test("a design whose index.html has data-slide is a deck", async () => {
    const ws = await mkdtemp(join(tmpdir(), "doi-"));
    dirs.push(ws);
    await Bun.write(join(ws, "projects/p/designs/deck/index.html"), '<section class="slide" data-slide>1</section>');
    await Bun.write(join(ws, "projects/p/designs/page/index.html"), '<div data-slider="x" data-slide-note>no</div>');
    expect(await listProjects(ws)).toEqual([{ id: "p", name: "p", designs: ["deck", "page"], decks: ["deck"], designSystem: null, repo: null }]);
  });
});
