import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiagram } from "../src/architecture/schema.ts";
import { ArchitectureError, readArchitecture, writeArchitecture } from "../src/workspace/architecture.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "doi-uml-store-")); roots.push(root);
  await mkdir(join(root, "projects", "test"), { recursive: true });
  return root;
}

test("reading UML creates nothing; disable and reload preserve saved diagrams", async () => {
  const root = await fixture();
  const first = await readArchitecture(root, "test");
  expect(first).toEqual({ revision: null, state: { version: 1, enabled: false, diagrams: [] } });
  expect(await readdir(join(root, "projects", "test"))).toEqual([]);
  const state = { ...first.state, enabled: true, diagrams: [createDiagram()] };
  const saved = await writeArchitecture(root, "test", first.revision, state);
  expect(await readArchitecture(root, "test")).toEqual(saved);
  const hidden = await writeArchitecture(root, "test", saved.revision, { ...state, enabled: false });
  expect(hidden.state.diagrams).toEqual(saved.state.diagrams);
  expect(hidden.revision).not.toBe(saved.revision);
  expect((await readdir(join(root, "projects", "test"))).some(p => p.endsWith(".tmp"))).toBe(false);
});

test("concurrent writers and external changes cannot silently replace data", async () => {
  const root = await fixture();
  const initial = await readArchitecture(root, "test");
  const results = await Promise.allSettled(["One", "Two"].map(name => writeArchitecture(root, "test", null, { ...initial.state, diagrams: [createDiagram(name)] })));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const failed = results.find(r => r.status === "rejected");
  expect(failed?.status === "rejected" && failed.reason instanceof ArchitectureError && failed.reason.status).toBe(409);
  const latest = await readArchitecture(root, "test");
  await Bun.write(join(root, "projects/test/architecture.json"), JSON.stringify({ ...latest.state, enabled: true }));
  await expect(writeArchitecture(root, "test", latest.revision, latest.state)).rejects.toMatchObject({ status: 409 });
});

test("corrupt files, missing projects and symlinks fail without replacement", async () => {
  const root = await fixture();
  const path = join(root, "projects/test/architecture.json");
  await Bun.write(path, "broken");
  await expect(readArchitecture(root, "test")).rejects.toMatchObject({ status: 422 });
  await expect(writeArchitecture(root, "test", null, { version: 1 })).rejects.toMatchObject({ status: 422 });
  expect(await Bun.file(path).text()).toBe("broken");
  await expect(readArchitecture(root, "gone")).rejects.toMatchObject({ status: 404 });
  await expect(readArchitecture(root, "../test")).rejects.toThrow("Invalid project");
  await rm(path);
  await Bun.write(join(root, "outside.json"), "private fixture");
  await symlink(join(root, "outside.json"), path);
  await expect(readArchitecture(root, "test")).rejects.toMatchObject({ status: 400 });
  expect(await Bun.file(join(root, "outside.json")).text()).toBe("private fixture");
});
