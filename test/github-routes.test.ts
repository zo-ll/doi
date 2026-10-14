import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhDeps } from "../src/github/gh.ts";
import { deleteProjectRepo, putProjectRepo, syncProjectRepo } from "../src/server/github.ts";
import { DesignLocks } from "../src/server/locks.ts";
import { listProjects } from "../src/workspace/paths.ts";

/** A gh that sees "me/app" only; a clone makes the folder; each rev-parse gives the next commit. */
function fakeGh(visible = ["me/app"]) {
  let n = 0;
  const calls: string[][] = [];
  const gh: GhDeps = {
    which: () => "/usr/bin/gh",
    async run(cmd) {
      calls.push(cmd);
      if (cmd[1] === "repo" && cmd[2] === "view") {
        return visible.includes(cmd[3]!)
          ? { code: 0, stdout: JSON.stringify({ nameWithOwner: cmd[3], description: "", isPrivate: false, primaryLanguage: null, updatedAt: "" }), stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (cmd[1] === "repo" && cmd[2] === "clone") {
        await mkdir(join(cmd[4]!, ".git"), { recursive: true });
        await Bun.write(join(cmd[4]!, ".git", "HEAD"), "ref: refs/heads/main\n");
      }
      if (cmd[1] === "rev-parse") return { code: 0, stdout: `commit${++n}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { gh, calls };
}

async function workspace() {
  const ws = await mkdtemp(join(tmpdir(), "doi-gh-routes-"));
  for (const p of ["shop", "blog"]) {
    await Bun.write(join(ws, "projects", p, "project.json"), JSON.stringify({ name: p }));
    await Bun.write(join(ws, "projects", p, "designs", "home", "index.html"), "<p>x</p>");
  }
  return ws;
}
const put = (body: unknown) => new Request("http://x/", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("link, update and unlink a repo; the clone goes with its last project", async () => {
  const ws = await workspace();
  const { gh } = fakeGh();
  const commits: string[] = [];
  const deps = { workspace: ws, locks: new DesignLocks(), gh, commit: async (_p: string[], m: string) => (commits.push(m), "sha") };

  const linked = await putProjectRepo(deps, put({ name: "me/app" }), { project: "shop" });
  expect(linked.status).toBe(200);
  expect(((await linked.json()) as { repo: { commit: string } }).repo.commit).toBe("commit1");
  await putProjectRepo(deps, put({ name: "me/app" }), { project: "blog" });
  const projects = await listProjects(ws);
  expect(projects.map((p) => p.repo?.name)).toEqual(["me/app", "me/app"]);

  const synced = (await (await syncProjectRepo(deps, new Request("http://x/", { method: "POST" }), { project: "shop" })).json()) as { repo: { commit: string } };
  expect(synced.repo.commit).toBe("commit3");

  await deleteProjectRepo(deps, { project: "shop" });
  expect(await Bun.file(join(ws, ".repos/me/app/.git/HEAD")).exists()).toBe(true); // blog still uses it
  await deleteProjectRepo(deps, { project: "blog" });
  expect(await Bun.file(join(ws, ".repos/me/app/.git/HEAD")).exists()).toBe(false);
  expect((await listProjects(ws)).every((p) => p.repo === null)).toBe(true);
  expect(commits).toEqual(["Link repo me/app", "Link repo me/app", "Update repo me/app", "Unlink repo me/app", "Unlink repo me/app"]);
});

test("a repo gh cannot see, a bad name, a missing project and a running clone are refused", async () => {
  const ws = await workspace();
  const { gh, calls } = fakeGh();
  const locks = new DesignLocks();
  const deps = { workspace: ws, locks, gh, commit: async () => null };
  expect((await putProjectRepo(deps, put({ name: "org/secret" }), { project: "shop" })).status).toBe(404);
  expect((await putProjectRepo(deps, put({ name: "--upload-pack=x" }), { project: "shop" })).status).toBe(400);
  expect((await putProjectRepo(deps, put({ name: "me/app" }), { project: "nope" })).status).toBe(404);
  expect((await syncProjectRepo(deps, new Request("http://x/", { method: "POST" }), { project: "shop" })).status).toBe(409);
  locks.tryLock("repo:me/app");
  expect((await putProjectRepo(deps, put({ name: "me/app" }), { project: "shop" })).status).toBe(409);
  expect(calls.some((c) => c[2] === "clone")).toBe(false);
});

test('a hand-edited "owner/.." link is no link, and unlinking it deletes no clone', async () => {
  const ws = await workspace();
  await Bun.write(join(ws, ".repos/me/app/.git/HEAD"), "ref: refs/heads/main\n");
  await Bun.write(join(ws, "projects/shop/project.json"), JSON.stringify({ name: "shop", repo: { name: "me/..", commit: "x" } }));
  expect((await listProjects(ws)).find((p) => p.id === "shop")?.repo).toBeNull();
  const { gh } = fakeGh();
  await deleteProjectRepo({ workspace: ws, locks: new DesignLocks(), gh, commit: async () => null }, { project: "shop" });
  expect(await Bun.file(join(ws, ".repos/me/app/.git/HEAD")).exists()).toBe(true);
});

test("unlink waits while the repo is cloned or updated", async () => {
  const ws = await workspace();
  const { gh } = fakeGh();
  const locks = new DesignLocks();
  const deps = { workspace: ws, locks, gh, commit: async () => null };
  await putProjectRepo(deps, put({ name: "me/app" }), { project: "shop" });
  locks.tryLock("repo:me/app");
  expect((await deleteProjectRepo(deps, { project: "shop" })).status).toBe(409);
  expect((await listProjects(ws)).find((p) => p.id === "shop")?.repo?.name).toBe("me/app");
  expect(await Bun.file(join(ws, ".repos/me/app/.git/HEAD")).exists()).toBe(true);
  locks.unlock("repo:me/app");
  expect((await deleteProjectRepo(deps, { project: "shop" })).status).toBe(200);
});
