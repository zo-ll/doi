import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { startServer } from "../src/server/app.ts";
import { appendChat } from "../src/workspace/chat.ts";
import { addComment } from "../src/workspace/comments.ts";
import { designSystemDir } from "../src/workspace/design-systems.ts";
import { designDir } from "../src/workspace/paths.ts";

let ws: string;

/** A workspace with one project, one design with two pages, a comment and a design system. */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doi-mcp-"));
  const dir = designDir(root, "shop", "home");
  await mkdir(join(dir, "img"), { recursive: true });
  await Bun.write(join(root, "projects", "shop", "project.json"), JSON.stringify({ name: "The Shop", designSystem: "brand", repo: null }));
  await Bun.write(join(dir, "index.html"), '<html><body><h1 data-oid="hero">Home</h1></body></html>');
  await Bun.write(join(dir, "about.html"), '<html><body><p data-oid="about">About</p></body></html>');
  await Bun.write(join(dir, "styles.css"), "h1 { color: red; }");
  await Bun.write(join(dir, "img", "a.png"), new Uint8Array([1, 2, 3]));
  await Bun.write(join(designSystemDir(root, "brand"), "tokens.css"), ":root { --accent: #c00; }");
  await Bun.write(join(designSystemDir(root, "brand"), "rules.md"), "Use the accent once.");
  await appendChat(root, "shop", { role: "user", turn: "t1", design: "home", at: "2026-10-14T00:00:00.000Z", text: "A shop home", target: null });
  await addComment(root, "shop", "home", { oid: "hero", text: "Bigger", version: null });
  await addComment(root, "shop", "home", { oid: "gone", text: "Old", version: null });
  return root;
}

const renders: { html: string; frames: { width: number }[] }[] = [];
const fakeRender = async (html: string, frames: { width: number; height: number }[]) => {
  renders.push({ html, frames });
  return frames.map(() => Buffer.from("png-bytes"));
};

async function connect(): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ workspace: ws, render: fakeRender }).connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return client;
}

const parsed = (r: any) => JSON.parse(r.content[0].text);

beforeAll(async () => {
  ws = await workspace();
});

describe("MCP tools", () => {
  test("lists the tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["export_png", "get_comments", "get_design", "get_design_system", "list_designs"]);
  });

  test("list_designs", async () => {
    const r = parsed(await (await connect()).callTool({ name: "list_designs", arguments: {} }));
    expect(r).toEqual({ projects: [{ id: "shop", name: "The Shop", designs: ["home"], decks: [], designSystem: "brand", repo: null }] });
  });

  test("get_design gives files, pages, frames and requests", async () => {
    const r = parsed(await (await connect()).callTool({ name: "get_design", arguments: { project: "shop", design: "home" } }));
    expect(r.folder).toBe(designDir(ws, "shop", "home"));
    expect(r.pages).toEqual(["index.html", "about.html"]);
    expect(r.frames.map((f: { id: string }) => f.id)).toEqual(["desktop", "mobile"]);
    expect(r.designSystem).toBe("brand");
    expect(r.requests).toEqual([{ text: "A shop home", element: null }]);
    expect(r.files).toContainEqual({ path: "styles.css", content: "h1 { color: red; }" });
    expect(r.files).toContainEqual({ path: "img/a.png", binary: true });
  });

  test("get_design_system", async () => {
    const r = parsed(await (await connect()).callTool({ name: "get_design_system", arguments: { project: "shop" } }));
    expect(r).toMatchObject({ designSystem: "brand", tokens: ":root { --accent: #c00; }", rules: "Use the accent once." });
  });

  test("get_comments gives open comments with detached", async () => {
    const r = parsed(await (await connect()).callTool({ name: "get_comments", arguments: { project: "shop", design: "home" } }));
    expect(r.comments.map((c: any) => [c.element, c.text, c.detached])).toEqual([
      ["hero", "Bigger", false],
      ["gone", "Old", true],
    ]);
  });

  test("export_png renders the page in the frame", async () => {
    renders.length = 0;
    const r: any = await (await connect()).callTool({ name: "export_png", arguments: { project: "shop", design: "home", page: "about.html", frame: "mobile" } });
    expect(r.content[0]).toEqual({ type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" });
    expect(r.content[1].text).toBe("about.html in the frame Mobile, 390 × 844.");
    expect(renders[0]!.html).toContain("About");
    expect(renders[0]!.frames[0]!.width).toBe(390);
  });

  test("bad names and missing designs are tool errors", async () => {
    const client = await connect();
    const missing: any = await client.callTool({ name: "get_design", arguments: { project: "shop", design: "nope" } });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('Design "shop/nope" not found');
    const bad: any = await client.callTool({ name: "get_comments", arguments: { project: "../etc", design: "home" } });
    expect(bad.isError).toBe(true);
    const frame: any = await client.callTool({ name: "export_png", arguments: { project: "shop", design: "home", frame: "tv" } });
    expect(frame.content[0].text).toBe('Frame "tv" not found. Frames: desktop, mobile.');
  });
});

describe("MCP over HTTP at /mcp", () => {
  let app: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  beforeAll(async () => {
    app = await startServer(parseConfig({ workspace: ws }), { port: 0, development: false });
    base = `http://127.0.0.1:${app.server.port}`;
  });
  afterAll(() => app.stop());

  test("a client connects and calls a tool", async () => {
    const client = new Client({ name: "agent", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const r = parsed(await client.callTool({ name: "list_designs", arguments: {} }));
    expect(r.projects.map((p: { id: string }) => p.id)).toContain("shop");
    await client.close();
  });

  test("a request from a web page is refused", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { accept: "application/json, text/event-stream" };
    const other = await fetch(`${base}/mcp`, { method: "POST", body, headers: { ...headers, "content-type": "application/json", origin: "https://evil.example" } });
    expect(other.status).toBe(403);
    const sandboxed = await fetch(`${base}/mcp`, { method: "POST", body, headers: { ...headers, "content-type": "application/json", origin: "null" } });
    expect(sandboxed.status).toBe(403);
    const simple = await fetch(`${base}/mcp`, { method: "POST", body, headers: { ...headers, "content-type": "text/plain" } });
    expect(simple.status).toBe(415);
    // A cross-site EventSource must not hold a stream open.
    const stream = await fetch(`${base}/mcp`, { headers: { accept: "text/event-stream", origin: "https://evil.example" } });
    expect(stream.status).toBe(403);
  });

  test("GET and DELETE get 405: the server is stateless", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${base}/mcp`, { method, headers: { accept: "text/event-stream" } });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });
});

describe("agent prompt", () => {
  test("names the design and the MCP URL, with no setup per agent", async () => {
    const { agentPrompt } = await import("../src/handoff/prompt.ts");
    const text = await agentPrompt(ws, "shop", "home", "http://127.0.0.1:4317/mcp");
    expect(text).toStartWith('Implement the design "home" of the doi project "The Shop" in this repository.');
    expect(text).toContain("- URL: http://127.0.0.1:4317/mcp");
    expect(text).toContain("Project id: `shop`. Design id: `home`.");
    for (const tool of ["list_designs", "get_design", "get_design_system", "get_comments", "export_png"]) expect(text).toContain(`\`${tool}\``);
    expect(text).not.toMatch(/\{\{\w+\}\}/);
    expect(text).not.toMatch(/claude|codex|opencode|gemini|aider/i);
    await expect(agentPrompt(ws, "shop", "nope", "x")).rejects.toThrow("Design not found.");
  });

  test("GET …/handoff/prompt uses the port of the running server", async () => {
    const app = await startServer(parseConfig({ workspace: ws }), { port: 0, development: false });
    try {
      const res = await fetch(`http://127.0.0.1:${app.server.port}/api/projects/shop/designs/home/handoff/prompt`);
      const body = (await res.json()) as { prompt: string; template: string; url: string };
      expect(body.template).toBe("v0");
      expect(body.url).toBe(`http://127.0.0.1:${app.server.port}/mcp`);
      expect(body.prompt).toContain(`- URL: http://127.0.0.1:${app.server.port}/mcp`);
    } finally {
      app.stop();
    }
  });
});
