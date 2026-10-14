import { expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatRepo, pickFiles, repoForTurn } from "../src/generation/repo-context.ts";
import { assembleContext } from "../src/generation/context.ts";

const repo = { name: "me/app", commit: "abcdef1234567", syncedAt: "" };

async function gitRepo() {
  const dir = await mkdtemp(join(tmpdir(), "doi-repo-ctx-"));
  const files: Record<string, string> = {
    "README.md": "# The app",
    "package.json": '{"name":"app"}',
    "src/pages/settings.tsx": "export default function Settings() { return <h1>Settings</h1>; }",
    "src/components/Button.tsx": "export const Button = () => <button />;",
    "src/lib/math.ts": "export const add = (a, b) => a + b;",
    ".env": "SECRET=1",
    "config/credentials.json": "{}",
  };
  for (const [p, c] of Object.entries(files)) await Bun.write(join(dir, p), c);
  await $`git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init`.cwd(dir).quiet();
  return dir;
}

test("a model that reads files gets the path and the tree; secrets are not listed", async () => {
  const dir = await gitRepo();
  const text = await formatRepo(repo, dir, true);
  expect(text).toStartWith("# The app: me/app");
  expect(text).toContain(`A read-only copy of its code is at ${dir}.`);
  expect(text).toContain("commit abcdef1");
  expect(text).toContain("src/pages/settings.tsx");
  expect(text).not.toContain(".env");
  expect(text).not.toContain("credentials");
  expect(text).not.toContain("return <h1>Settings</h1>"); // no file text: it reads the files itself
});

test("other models get the start files and the UI files, not the rest", async () => {
  const dir = await gitRepo();
  const picked = await pickFiles(dir, ["src/lib/math.ts", "src/pages/settings.tsx", "README.md", "src/components/Button.tsx", "package.json"]);
  expect(picked.map((f) => f.path)).toEqual(["package.json", "README.md", "src/components/Button.tsx", "src/pages/settings.tsx"]);
  const text = await formatRepo(repo, dir, false);
  expect(text).toContain("## src/pages/settings.tsx");
  expect(text).toContain("return <h1>Settings</h1>");
  expect(text).not.toContain("SECRET=1");
});

test("the repo part goes into the system text after the design system", () => {
  const caps = { vision: false, toolUse: true, promptCache: "none" as const, maxContextTokens: 200_000, editsFiles: false };
  const ctx = assembleContext({ systemPrompt: "rules", designSystem: "ds", repo: "# The app: me/app", files: [], history: [], turn: { text: "x" }, capabilities: caps });
  expect(ctx.system.slice(0, 3)).toEqual(["rules", "ds", "# The app: me/app"]);
});

test("a turn gets nothing without a linked repo or without its clone; a model's change to the clone is undone", async () => {
  const ws = await mkdtemp(join(tmpdir(), "doi-repo-turn-"));
  await Bun.write(join(ws, "projects/p/project.json"), JSON.stringify({ name: "p" }));
  expect(await repoForTurn(ws, "p", true)).toBeNull();
  await Bun.write(join(ws, "projects/p/project.json"), JSON.stringify({ name: "p", repo }));
  expect(await repoForTurn(ws, "p", true)).toBeNull(); // no clone yet
  const clone = join(ws, ".repos/me/app");
  await $`git clone -q ${await gitRepo()} ${clone}`.quiet();
  await Bun.write(join(clone, "README.md"), "changed by a model");
  await Bun.write(join(clone, "new.txt"), "added by a model");
  const got = await repoForTurn(ws, "p", true);
  expect(got?.dir).toBe(clone);
  expect(await Bun.file(join(clone, "README.md")).text()).toBe("# The app");
  expect(await Bun.file(join(clone, "new.txt")).exists()).toBe(false);
});
