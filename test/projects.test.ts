import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesignLocks, designKey } from "../src/server/locks.ts";
import { deleteProject, patchDesign, patchProject, postDesign, postProject, postScreen, putDesignKind, type ProjectDeps } from "../src/server/projects.ts";
import { appendChat, readChat } from "../src/workspace/chat.ts";
import { listProjects, designDir } from "../src/workspace/paths.ts";
import { slugify } from "../src/workspace/projects.ts";
import { isApp, readLayout, slideLayout } from "../src/workspace/layout.ts";

let deps: ProjectDeps;
let commits: { paths: string[]; message: string }[];

beforeEach(async () => {
  commits = [];
  deps = {
    workspace: await mkdtemp(join(tmpdir(), "doi-projects-")),
    locks: new DesignLocks(),
    commit: async (paths, message) => {
      commits.push({ paths: paths.map((p) => p.slice(deps.workspace.length + 1)), message });
      return "c".repeat(40);
    },
  };
});

const json = (method: string, body: unknown) =>
  new Request("http://x/", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("projects API", () => {
  test("creates a project with a home design and commits it", async () => {
    const res = await postProject(deps, json("POST", { name: "My Shop!" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "my-shop", design: "home" });
    expect(await listProjects(deps.workspace)).toEqual([{ id: "my-shop", name: "My Shop!", designs: ["home"], decks: [], apps: [], designSystem: null, repo: null }]);
    expect(await Bun.file(join(designDir(deps.workspace, "my-shop", "home"), "index.html")).text()).toContain('data-oid="main"');
    expect(commits).toEqual([
      { paths: ["projects/my-shop/project.json", "projects/my-shop/designs/home"], message: "Create project My Shop!" },
    ]);
  });

  test("names follow the rules, and a taken name is a conflict", async () => {
    expect((await postProject(deps, json("POST", { name: "!!!" }))).status).toBe(400); // slug is empty
    expect((await postProject(deps, json("POST", { name: "Shop", id: "Bad_Id" }))).status).toBe(400);
    expect((await postProject(deps, json("POST", { name: "" }))).status).toBe(400);
    expect((await postProject(deps, json("POST", { name: "x".repeat(81) }))).status).toBe(400);
    expect((await postProject(deps, new Request("http://x/", { method: "POST", body: "nope" }))).status).toBe(400);
    expect((await postProject(deps, json("POST", { name: "Shop" }))).status).toBe(201);
    const again = await postProject(deps, json("POST", { name: "shop" }));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toContain("already exists");
  });

  test("renames a project's display name and keeps its id and other fields", async () => {
    await postProject(deps, json("POST", { name: "Shop" }));
    const res = await patchProject(deps, json("PATCH", { name: "  The Shop  " }), { project: "shop" });
    expect(res.status).toBe(200);
    const meta = await Bun.file(join(deps.workspace, "projects", "shop", "project.json")).json();
    expect(meta).toEqual({ name: "The Shop", designSystem: null, viewports: [1440, 390] });
    expect((await patchProject(deps, json("PATCH", { name: "x" }), { project: "none" })).status).toBe(404);
    expect((await patchProject(deps, json("PATCH", { name: "x" }), { project: "../shop" })).status).toBe(400);
  });

  test("creates designs with valid, free names", async () => {
    await postProject(deps, json("POST", { name: "Shop" }));
    expect((await postDesign(deps, json("POST", { id: "pricing" }), { project: "shop" })).status).toBe(201);
    expect((await postDesign(deps, json("POST", { id: "pricing" }), { project: "shop" })).status).toBe(409);
    expect((await postDesign(deps, json("POST", { id: "../x" }), { project: "shop" })).status).toBe(400);
    expect((await postDesign(deps, json("POST", { id: "a" }), { project: "none" })).status).toBe(404);
    expect((await listProjects(deps.workspace))[0]!.designs).toEqual(["home", "pricing"]);
  });

  test("a slide deck starts with one slide and the Slide frame", async () => {
    await postProject(deps, json("POST", { name: "Shop" }));
    expect((await postDesign(deps, json("POST", { id: "pitch", kind: "slides" }), { project: "shop" })).status).toBe(201);
    const dir = designDir(deps.workspace, "shop", "pitch");
    expect(await Bun.file(join(dir, "index.html")).text()).toContain('<section class="slide" data-slide data-oid="slide-1">');
    expect(await Bun.file(join(dir, "styles.css")).text()).toContain("height: 1080px");
    expect(await readLayout(deps.workspace, "shop", "pitch")).toEqual(slideLayout());
    expect(slideLayout()).toEqual([{ id: "slide", label: "Slide", width: 1920, height: 1080, x: 0, y: 0 }]);
    // The layout is in project.json, so the commit has it too.
    expect(commits.at(-1)).toEqual({ paths: ["projects/shop/designs/pitch", "projects/shop/project.json"], message: "Create design pitch" });
    // A page keeps the default layout, and an unknown kind is refused.
    await postDesign(deps, json("POST", { id: "about", kind: "page" }), { project: "shop" });
    expect((await readLayout(deps.workspace, "shop", "about")).map((f) => f.id)).toEqual(["desktop", "mobile"]);
    expect((await postDesign(deps, json("POST", { id: "x", kind: "poster" }), { project: "shop" })).status).toBe(400);
    expect(existsSync(designDir(deps.workspace, "shop", "x"))).toBe(false);
  });

  test("a mobile app is marked in project.json and starts with one screen", async () => {
    await postProject(deps, json("POST", { name: "Shop" }));
    const res = await postDesign(deps, json("POST", { id: "phone", kind: "app" }), { project: "shop" });
    expect(res.status).toBe(201);
    expect(await isApp(deps.workspace, "shop", "phone")).toBe(true);
    expect(await Bun.file(join(designDir(deps.workspace, "shop", "phone"), "index.html")).text()).toContain('data-oid="home-screen"');
    expect((await listProjects(deps.workspace))[0]).toMatchObject({ designs: ["home", "phone"], apps: ["phone"] });
    expect(commits.at(-1)!.paths).toContain("projects/shop/project.json");
  });

  test("a design switches between a page and a mobile app; a rename keeps the mark", async () => {
    await postProject(deps, json("POST", { name: "Shop" }));
    const put = (app: unknown, design = "home") => putDesignKind(deps, json("PUT", { app }), { project: "shop", design });
    expect((await put(true)).status).toBe(200);
    expect((await listProjects(deps.workspace))[0]!.apps).toEqual(["home"]);
    expect(commits.at(-1)!.message).toBe("Make home a mobile app");
    expect((await put("yes")).status).toBe(400);
    expect((await put(true, "missing")).status).toBe(404);
    await patchDesign(deps, json("PATCH", { id: "app" }), { project: "shop", design: "home" });
    expect((await listProjects(deps.workspace))[0]!.apps).toEqual(["app"]);
    expect((await put(false, "app")).status).toBe(200);
    expect((await listProjects(deps.workspace))[0]!.apps).toEqual([]);
  });

  test("a new screen copies the head of index.html and gets an empty main", async () => {
    await postProject(deps, json("POST", { name: "Shop" }));
    const dir = designDir(deps.workspace, "shop", "home");
    await Bun.write(join(dir, "index.html"), '<!doctype html><html><head><link rel="stylesheet" href="styles.css"><link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"></head><body><main data-oid="main">Home</main></body></html>');
    const post = (name: unknown) => postScreen(deps, json("POST", { name }), { project: "shop", design: "home" });
    const res = await post("files");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ page: "files.html" });
    const html = await Bun.file(join(dir, "files.html")).text();
    expect(html).toContain('<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">');
    expect(html).toContain('<main class="screen" data-oid="files-screen"></main>');
    expect(commits.at(-1)!.message).toBe("Add screen files.html");
    expect((await post("files")).status).toBe(409);
    for (const bad of ["index", "Files", "../x", "", 3]) expect((await post(bad)).status).toBe(400);
    deps.locks.tryLock(designKey("shop", "home"));
    expect((await post("busy")).status).toBe(409);
  });

  test("renaming a design moves its folder and its chat", async () => {
    await postProject(deps, json("POST", { name: "Shop" }));
    await postDesign(deps, json("POST", { id: "about" }), { project: "shop" });
    const at = "2026-10-12T00:00:00.000Z";
    await appendChat(deps.workspace, "shop", { role: "user", turn: "t1", design: "home", at, text: "a", target: null });
    await appendChat(deps.workspace, "shop", { role: "user", turn: "t2", design: "about", at, text: "b", target: null });

    const res = await patchDesign(deps, json("PATCH", { id: "start" }), { project: "shop", design: "home" });
    expect(res.status).toBe(200);
    expect(existsSync(designDir(deps.workspace, "shop", "home"))).toBe(false);
    expect(existsSync(join(designDir(deps.workspace, "shop", "start"), "index.html"))).toBe(true);
    expect((await readChat(deps.workspace, "shop", "start")).map((e) => e.turn)).toEqual(["t1"]);
    expect((await readChat(deps.workspace, "shop", "about")).map((e) => e.turn)).toEqual(["t2"]);
    expect(commits.at(-1)).toEqual({
      paths: ["projects/shop/designs/home", "projects/shop/designs/start", "projects/shop/chat.jsonl", "projects/shop/project.json"],
      message: "Rename design home to start",
    });

    expect((await patchDesign(deps, json("PATCH", { id: "about" }), { project: "shop", design: "start" })).status).toBe(409);
    expect((await patchDesign(deps, json("PATCH", { id: "x" }), { project: "shop", design: "none" })).status).toBe(404);
    expect((await patchDesign(deps, json("PATCH", { id: "Bad" }), { project: "shop", design: "start" })).status).toBe(400);
  });

  test("a design cannot be renamed while a turn runs on it, or onto one", async () => {
    await postProject(deps, json("POST", { name: "Shop" }));
    deps.locks.tryLock(designKey("shop", "home"));
    const res = await patchDesign(deps, json("PATCH", { id: "start" }), { project: "shop", design: "home" });
    expect(res.status).toBe(409);
    expect(existsSync(designDir(deps.workspace, "shop", "home"))).toBe(true);
    deps.locks.unlock(designKey("shop", "home"));

    deps.locks.tryLock(designKey("shop", "start"));
    expect((await patchDesign(deps, json("PATCH", { id: "start" }), { project: "shop", design: "home" })).status).toBe(409);
    deps.locks.unlock(designKey("shop", "start"));
    // The failed attempts left no lock behind.
    expect((await patchDesign(deps, json("PATCH", { id: "start" }), { project: "shop", design: "home" })).status).toBe(200);
  });

  test("a failed commit does not undo the change", async () => {
    deps.commit = async () => {
      throw new Error("git commit failed: no identity");
    };
    const res = await postProject(deps, json("POST", { name: "Shop" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "shop", commitError: "git commit failed: no identity" });
  });

  test("slugify", () => {
    expect(slugify("Café Menu 2")).toBe("cafe-menu-2");
    expect(slugify("--A--B--")).toBe("a-b");
  });

  test("renames and chat appends at the same time keep every chat line", async () => {
    await postProject(deps, json("POST", { name: "Shop" }));
    const at = "2026-10-12T00:00:00.000Z";
    const designs = ["a", "b", "c", "d"];
    for (const d of designs) {
      await postDesign(deps, json("POST", { id: d }), { project: "shop" });
      await appendChat(deps.workspace, "shop", { role: "user", turn: `t-${d}`, design: d, at, text: d, target: null });
    }
    const results = await Promise.all([
      ...designs.map((d) => patchDesign(deps, json("PATCH", { id: `${d}-new` }), { project: "shop", design: d })),
      ...Array.from({ length: 20 }, (_, i) =>
        appendChat(deps.workspace, "shop", { role: "user", turn: `x${i}`, design: "home", at, text: String(i), target: null }),
      ),
    ]);
    expect(results.slice(0, designs.length).map((r) => (r as Response).status)).toEqual([200, 200, 200, 200]);
    for (const d of designs) expect((await readChat(deps.workspace, "shop", `${d}-new`)).map((e) => e.turn)).toEqual([`t-${d}`]);
    expect(await readChat(deps.workspace, "shop", "home")).toHaveLength(20);
  });
});

describe("delete project", () => {
  const linkRepo = async (project: string, name: string) => {
    const file = join(deps.workspace, "projects", project, "project.json");
    const meta = await Bun.file(file).json();
    await Bun.write(file, JSON.stringify({ ...meta, repo: { name, commit: "c1", syncedAt: "2026-10-15T00:00:00Z" } }));
  };
  const clone = (name: string) => join(deps.workspace, ".repos", name);

  test("removes the folder with its designs, chat and variants, and commits it", async () => {
    await postProject(deps, json("POST", { name: "Shop" }));
    await postProject(deps, json("POST", { name: "Blog" }));
    await appendChat(deps.workspace, "shop", { role: "user", turn: "t", design: "home", at: "2026-10-15T00:00:00Z", text: "Hi", target: null });
    await Bun.write(join(deps.workspace, "projects/shop/variants/home/s1/set.json"), "{}");
    commits = [];
    const res = await deleteProject(deps, { project: "shop" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "shop" });
    expect(existsSync(join(deps.workspace, "projects/shop"))).toBe(false);
    expect((await listProjects(deps.workspace)).map((p) => p.id)).toEqual(["blog"]);
    expect(commits).toEqual([{ paths: ["projects/shop"], message: "Delete project Shop" }]);
  });

  test("unknown, bad or busy projects are refused", async () => {
    expect((await deleteProject(deps, { project: "nobody" })).status).toBe(404);
    expect((await deleteProject(deps, { project: "../x" })).status).toBe(400);
    await postProject(deps, json("POST", { name: "Shop" }));
    deps.locks.tryLock(designKey("shop", "home"));
    expect((await deleteProject(deps, { project: "shop" })).status).toBe(409);
    expect(existsSync(join(deps.workspace, "projects/shop"))).toBe(true);
    deps.locks.unlock(designKey("shop", "home"));
    // A clone or update of its repo holds the repo lock.
    await linkRepo("shop", "me/app");
    deps.locks.tryLock("repo:me/app");
    expect((await deleteProject(deps, { project: "shop" })).status).toBe(409);
  });

  test("the repo clone goes with the last project that links it", async () => {
    await postProject(deps, json("POST", { name: "Shop" }));
    await postProject(deps, json("POST", { name: "Blog" }));
    await linkRepo("shop", "me/app");
    await linkRepo("blog", "Me/App");
    await Bun.write(join(clone("me/app"), ".git/HEAD"), "ref: refs/heads/main\n");
    await deleteProject(deps, { project: "shop" });
    expect(existsSync(clone("me/app"))).toBe(true); // blog still uses it
    await deleteProject(deps, { project: "blog" });
    expect(existsSync(clone("me/app"))).toBe(false);
  });
});
