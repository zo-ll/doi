import { afterAll, beforeAll, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportArchive, importArchive, planImport, readArchive } from "../src/workspace/archive.ts";
import { appendCommit } from "../src/workspace/chat.ts";
import { zip } from "../src/export/zip.ts";
import { commitTurn, designLog, ensureRepo } from "../src/workspace/git.ts";
import { listProjects } from "../src/workspace/paths.ts";

const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "doi-gitcfg-"));
  await Bun.write(join(home, "gitconfig"), "[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A workspace with the project "shop" (two versions, a comment, a commit line) using "brand", and "blog". */
async function source() {
  const ws = await mkdtemp(join(tmpdir(), "doi-arch-src-"));
  await ensureRepo(ws);
  const home = join(ws, "projects/shop/designs/home");
  await Bun.write(join(ws, "projects/shop/project.json"), JSON.stringify({ name: "The Shop", designSystem: "brand" }));
  await Bun.write(join(ws, "design-systems/brand/tokens.css"), ":root { --accent: #c00; }");
  await Bun.write(join(ws, "design-systems/brand/components.css"), '@import "/ds/brand/tokens.css";');
  await Bun.write(join(ws, "projects/shop/designs/home/styles.css"), '@import "/ds/brand/tokens.css";\nh1 { color: var(--accent); }');
  await Bun.write(join(home, "index.html"), '<link rel="stylesheet" href="/ds/brand/tokens.css"><h1 data-oid="t">One</h1>');
  await Bun.write(join(ws, "projects/blog/project.json"), JSON.stringify({ name: "Blog" }));
  await Bun.write(join(ws, "projects/blog/designs/home/index.html"), "<p>blog</p>");
  await $`git add -A && git commit -qm First`.cwd(ws).quiet();
  await Bun.write(join(home, "index.html"), '<link rel="stylesheet" href="/ds/brand/tokens.css"><h1 data-oid="t">Two</h1>');
  const sha = (await commitTurn(ws, "shop", "home", "Make it two"))!;
  await appendCommit(ws, "shop", { turn: "t1", design: "home", sha });
  await Bun.write(join(home, ".comments.json"), JSON.stringify([{ id: "c1", oid: "t", text: "Bigger", status: "open", version: null, createdAt: "x" }]));
  await Bun.write(join(home, "draft.css"), "/* not committed yet */");
  return { ws, sha };
}

test("a project moves to a workspace that has a 'shop' and another 'brand': new names, links, history and commit ids", async () => {
  const { ws: src } = await source();
  const { bytes, manifest } = await exportArchive(src, { kind: "project", projects: ["shop"], ui: { theme: "dark", panels: null, lastDesign: null } });
  expect(manifest.designSystems).toEqual(["brand"]);
  expect(manifest.history).toBe(true);
  expect(readArchive(bytes).entries.some((e) => e.path.includes("blog"))).toBe(false);

  const dst = await mkdtemp(join(tmpdir(), "doi-arch-dst-"));
  await ensureRepo(dst);
  await Bun.write(join(dst, "projects/shop/project.json"), JSON.stringify({ name: "Mine" }));
  await Bun.write(join(dst, "projects/shop/designs/home/index.html"), "<p>mine</p>");
  await Bun.write(join(dst, "design-systems/brand/tokens.css"), ":root { --accent: blue; }");
  await $`git add -A && git commit -qm Mine`.cwd(dst).quiet();

  const plan = await planImport(dst, bytes);
  expect(plan.projects).toEqual([{ from: "shop", to: "shop-2", name: "The Shop" }]);
  expect(plan.designSystems).toEqual([{ from: "brand", to: "brand-2", reused: false }]);

  const r = await importArchive(dst, bytes);
  expect(r.history).toBe(true);
  expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
  const shop2 = (await listProjects(dst)).find((p) => p.id === "shop-2")!;
  expect(shop2).toMatchObject({ name: "The Shop", designSystem: "brand-2", designs: ["home"] });
  const dir = join(dst, "projects/shop-2/designs/home");
  expect(await Bun.file(join(dir, "index.html")).text()).toContain('href="/ds/brand-2/tokens.css"');
  expect(await Bun.file(join(dir, "styles.css")).text()).toStartWith('@import "/ds/brand-2/tokens.css";');
  expect(await Bun.file(join(dst, "design-systems/brand-2/components.css")).text()).toBe('@import "/ds/brand-2/tokens.css";');
  expect(await Bun.file(join(dir, ".comments.json")).text()).toContain("Bigger");
  expect(await Bun.file(join(dir, "draft.css")).text()).toBe("/* not committed yet */");
  expect(await Bun.file(join(dst, "design-systems/brand-2/tokens.css")).text()).toContain("#c00");
  expect(await Bun.file(join(dst, "design-systems/brand/tokens.css")).text()).toContain("blue");
  // The history of the design came along, newest first; the chat names the new commit.
  const log = await designLog(dst, "shop-2", "home");
  expect(log.map((v) => v.message)).toEqual(["Import project The Shop", "Make it two", "First"]);
  const chat = await Bun.file(join(dst, "projects/shop-2/chat.jsonl")).text();
  expect(chat).toContain(log[1]!.sha);
  // The target's own project is untouched.
  expect(await Bun.file(join(dst, "projects/shop/designs/home/index.html")).text()).toBe("<p>mine</p>");
});

test("a workspace export imports into an empty workspace; a second import of the same file makes copies, and the same design system is reused", async () => {
  const { ws: src } = await source();
  const { bytes } = await exportArchive(src, { kind: "workspace" });
  const dst = await mkdtemp(join(tmpdir(), "doi-arch-empty-"));
  await ensureRepo(dst);
  const first = await importArchive(dst, bytes);
  expect(first.projects.map((p) => p.to).sort()).toEqual(["blog", "shop"]);
  expect((await designLog(dst, "shop", "home")).length).toBe(3);
  const again = await importArchive(dst, bytes);
  expect(again.projects.map((p) => p.to).sort()).toEqual(["blog-2", "shop-2"]);
  expect(again.projects.map((p) => p.name).sort()).toEqual(["Blog 2", "The Shop 2"]);
  expect((await listProjects(dst)).find((p) => p.id === "shop-2")?.name).toBe("The Shop 2");
  expect(again.designSystems).toEqual([{ from: "brand", to: "brand", reused: true }]);
  expect((await listProjects(dst)).find((p) => p.id === "shop-2")?.designSystem).toBe("brand");
});

test("bad files are refused before anything is written", async () => {
  const dst = await mkdtemp(join(tmpdir(), "doi-arch-bad-"));
  const enc = new TextEncoder();
  const f = (path: string, text: string) => ({ path, data: enc.encode(text) as Uint8Array<ArrayBuffer> });
  const manifest = { format: "doi-export", version: 1, kind: "project", createdAt: "", projects: [{ id: "p", name: "P", designs: [] }], designSystems: [], history: false, settings: null, ui: null };
  await expect(importArchive(dst, enc.encode("hello"))).rejects.toThrow("not a ZIP");
  await expect(importArchive(dst, zip([f("x.txt", "x")]))).rejects.toThrow("no manifest.json");
  await expect(importArchive(dst, zip([f("manifest.json", JSON.stringify({ ...manifest, version: 9 }))]))).rejects.toThrow("newer doi");
  await expect(importArchive(dst, zip([f("manifest.json", JSON.stringify(manifest)), f("files/projects/other/x", "x")]))).rejects.toThrow("unexpected entry");
  await expect(importArchive(dst, zip([f("manifest.json", JSON.stringify({ ...manifest, projects: [{ id: "../up", name: "x", designs: [] }] }))]))).rejects.toThrow("bad project");
  for (const designs of [undefined, "home", ["../x"], [3]]) {
    await expect(importArchive(dst, zip([f("manifest.json", JSON.stringify({ ...manifest, projects: [{ id: "p", name: "P", designs }] }))]))).rejects.toThrow("bad project");
  }
  expect(await Bun.file(join(dst, "projects")).exists()).toBe(false);
});
