import { expect, test } from "bun:test";
import { APP_PROMPT, assembleContext } from "../src/generation/context.ts";
import { FRAME_GAP, screenFrames } from "../src/workspace/frames.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseConfig } from "../src/config.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { startServer } from "../src/server/app.ts";
import { commitPaths } from "../src/workspace/git.ts";
import { designDir } from "../src/workspace/paths.ts";
import { createProject, setAppKind, WorkspaceError } from "../src/workspace/projects.ts";

test("a mobile app shows one phone frame per page, in a row", () => {
  expect(screenFrames(["index.html", "files.html"])).toEqual([
    { id: "screen-0", label: "index", width: 390, height: 844, x: 0, y: 0, page: "index.html" },
    { id: "screen-1", label: "files", width: 390, height: 844, x: 390 + FRAME_GAP, y: 0, page: "files.html" },
  ]);
  expect(screenFrames(Array.from({ length: 30 }, (_, i) => `s${i}.html`))).toHaveLength(24);
});

test("the model gets the app section only for a mobile app", () => {
  const input = {
    systemPrompt: "rules",
    files: [{ path: "index.html", content: "<main></main>" }],
    history: [],
    turn: { text: "add a files screen", target: null },
    capabilities: { vision: true, toolUse: true, promptCache: "automatic" as const, maxContextTokens: 100_000, editsFiles: false },
  };
  expect(assembleContext({ ...input, app: true }).system.slice(0, 2)).toEqual(["rules", APP_PROMPT]);
  expect(assembleContext(input).system).not.toContain(APP_PROMPT);
  expect(APP_PROMPT).toContain("add new pages");
});

async function appWorkspace() {
  const app = await startServer(parseConfig({ workspace: await mkdtemp(join(tmpdir(), "doi-app-")) }), { port: 0, development: false });
  await createProject(app.workspace, "Phone");
  await setAppKind(app.workspace, "phone", "home", true);
  return app;
}

test("the pages of an older version, for the history preview of an app", async () => {
  const app = await appWorkspace();
  try {
    const dir = designDir(app.workspace, "phone", "home");
    const first = await commitPaths(app.workspace, [dir], "First");
    await Bun.write(join(dir, "files.html"), "<main></main>");
    const base = `http://127.0.0.1:${app.server.port}/api/projects/phone/designs/home/pages`;
    expect(await (await fetch(base)).json()).toEqual(["index.html", "files.html"]);
    expect(await (await fetch(`${base}?sha=${first}`)).json()).toEqual(["index.html"]);
    expect((await fetch(`${base}?sha=nope`)).status).toBe(400);
  } finally {
    app.stop();
  }
});

test("a deck cannot be a mobile app", async () => {
  const app = await appWorkspace();
  try {
    await Bun.write(join(designDir(app.workspace, "phone", "home"), "index.html"), '<section data-slide data-oid="s1"></section>');
    await expect(setAppKind(app.workspace, "phone", "home", true)).rejects.toThrow(WorkspaceError);
    await setAppKind(app.workspace, "phone", "home", false); // back to a page always works
  } finally {
    app.stop();
  }
});

test("over MCP, an app has one phone frame and the kind app", async () => {
  const app = await appWorkspace();
  try {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer({ workspace: app.workspace }).connect(a);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    const r: any = await client.callTool({ name: "get_design", arguments: { project: "phone", design: "home" } });
    const design = JSON.parse(r.content[0].text);
    expect(design.kind).toBe("app");
    expect(design.frames).toEqual([{ id: "phone", label: "Phone", width: 390, height: 844 }]);
  } finally {
    app.stop();
  }
});
