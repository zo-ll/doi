import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { chromium } from "playwright-core";
import type { ElementInfo } from "../src/mcp/element.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { startServer } from "../src/server/app.ts";
import { appendChat } from "../src/workspace/chat.ts";
import { readArchitecture, writeArchitecture } from "../src/workspace/architecture.ts";
import { createDiagram } from "../src/architecture/schema.ts";
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

const inspections: { html: string; width: number; oid: string }[] = [];
const fakeInspect = async (html: string, frame: { width: number }, oid: string) => {
  inspections.push({ html, width: frame.width, oid });
  return html.toLowerCase().includes(`data-oid="${oid}"`) ? ({ oid, tag: "x" } as ElementInfo) : null;
};

async function connect(useChromium = false): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ workspace: ws, render: fakeRender, ...(useChromium ? {} : { inspect: fakeInspect }) }).connect(a);
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
    expect(tools.map((t) => t.name).sort()).toEqual(["export_png", "get_architecture", "get_comments", "get_design", "get_design_system", "get_element", "list_designs", "render_architecture", "update_architecture"]);
  });

  test("list_designs", async () => {
    const r = parsed(await (await connect()).callTool({ name: "list_designs", arguments: {} }));
    expect(r).toEqual({ projects: [{ id: "shop", name: "The Shop", designs: ["home"], decks: [], apps: [], designSystem: "brand", repo: null }] });
  });

  test("get_architecture reads the same saved graphs without enabling the feature", async () => {
    const client = await connect();
    try {
      expect(parsed(await client.callTool({ name: "get_architecture", arguments: { project: "shop" } }))).toEqual({ revision: null, state: { version: 1, enabled: false, diagrams: [] } });
      expect(await Bun.file(join(ws, "projects/shop/architecture.json")).exists()).toBe(false);
      const first = await readArchitecture(ws, "shop");
      const saved = await writeArchitecture(ws, "shop", first.revision, { ...first.state, enabled: true, diagrams: [createDiagram()] });
      expect(parsed(await client.callTool({ name: "get_architecture", arguments: { project: "shop" } }))).toEqual(saved);
      expect((await client.callTool({ name: "get_architecture", arguments: { project: "../shop" } })).isError).toBe(true);
    } finally { await client.close(); }
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

  test("get_element finds the element's page and inspects it in the frame", async () => {
    inspections.length = 0;
    const client = await connect();
    const r = parsed(await client.callTool({ name: "get_element", arguments: { project: "shop", design: "home", oid: "about", frame: "mobile" } }));
    expect(r.page).toBe("about.html");
    expect(r.frame).toEqual({ id: "mobile", label: "Mobile", width: 390, height: 844 });
    expect(r.element).toEqual({ oid: "about", tag: "x" });
    expect(inspections[0]!.width).toBe(390);
    expect(inspections[0]!.html).toContain('data-oid="about"'); // the page keeps its data-oids

    const none: any = await client.callTool({ name: "get_element", arguments: { project: "shop", design: "home", oid: "gone" } });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toBe('No page of "shop/home" has data-oid "gone". Call get_design or get_comments.');
    // a page copied from a node link is URL-encoded
    expect(parsed(await client.callTool({ name: "get_element", arguments: { project: "shop", design: "home", oid: "about", page: "about%2Ehtml" } })).page).toBe("about.html");
    const wrongPage: any = await client.callTool({ name: "get_element", arguments: { project: "shop", design: "home", oid: "hero", page: "about.html" } });
    expect(wrongPage.content[0].text).toBe('about.html has no element with data-oid "hero".');
    const bad: any = await client.callTool({ name: "get_element", arguments: { project: "shop", design: "home", oid: "a\"b" } });
    expect(bad.content[0].text).toBe("A data-oid has only letters, digits, - and _.");
  });

  test("get_element finds the page with the element, not a page that only names it", async () => {
    const dir = designDir(ws, "shop", "home");
    // "a-notes" comes before "about" and "index" in the file order; its oid is only in a comment and a script
    await Bun.write(join(dir, "a-notes.html"), '<html><body><!-- data-oid="about" --><script>document.querySelector(\'[data-oid="about"]\')</script><p data-oid="n">x</p></body></html>');
    await Bun.write(join(dir, "b-upper.html"), '<html><body><p DATA-OID="upper">Up</p></body></html>');
    try {
      const client = await connect();
      expect(parsed(await client.callTool({ name: "get_element", arguments: { project: "shop", design: "home", oid: "about" } })).page).toBe("about.html");
      expect(parsed(await client.callTool({ name: "get_element", arguments: { project: "shop", design: "home", oid: "upper" } })).page).toBe("b-upper.html");
    } finally {
      await Bun.file(join(dir, "a-notes.html")).delete();
      await Bun.file(join(dir, "b-upper.html")).delete();
    }
  });

  test("get_element gives the install hint only for a missing Chromium", async () => {
    const call = async (message: string) => {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await createMcpServer({ workspace: ws, render: fakeRender, inspect: async () => { throw new Error(message); } }).connect(a);
      const client = new Client({ name: "test", version: "1" });
      await client.connect(b);
      const r: any = await client.callTool({ name: "get_element", arguments: { project: "shop", design: "home", oid: "hero" } });
      return r.content[0].text as string;
    };
    expect(await call("Chromium for Playwright is not installed. Run: doi install-browser")).toStartWith("doi has no Chromium.");
    expect(await call("Target page, context or browser has been closed")).toBe("Target page, context or browser has been closed");
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

// get_element with the real inspector needs Chromium; CI installs it, so only a local run skips.
const hasBrowser = await chromium.launch().then(
  (b) => b.close().then(() => true),
  () => false,
);
test.if(!!process.env.CI)("CI has Chromium for the get_element tests", () => {
  expect(hasBrowser).toBe(true);
});

describe.skipIf(!hasBrowser)("get_element in Chromium", () => {
  test("gives the box, styles, matched rules, path and children", async () => {
    const dir = designDir(ws, "shop", "home");
    await Bun.write(
      join(dir, "card.html"),
      '<html><head><link rel="stylesheet" href="styles.css"><style>@media (min-width: 600px) { .card { padding: 24px; } }</style></head>' +
        '<body style="margin:0"><main data-oid="page"><section class="card" data-oid="card" style="width:300px">' +
        '<div><h2 data-oid="title">Hi</h2></div><p data-oid="body">Text</p></section></main></body></html>',
    );
    await Bun.write(join(dir, "styles.css"), "h1 { color: red; }\n.card { color: rgb(0, 0, 255); margin: 10px; }");
    try {
      const client = await connect(true);
      const desktop = parsed(await client.callTool({ name: "get_element", arguments: { project: "shop", design: "home", oid: "card" } }));
      const el = desktop.element;
      expect(desktop.page).toBe("card.html");
      expect(el.tag).toBe("section");
      expect(el.attributes).toEqual({ class: "card", "data-oid": "card", style: "width:300px" });
      expect(el.box).toEqual({ x: 10, y: 10, width: 348, height: el.box.height }); // 300 + 2 × 24 padding
      expect(el.visible).toBe(true);
      expect(el.styles.color).toBe("rgb(0, 0, 255)");
      expect(el.styles["padding"]).toBe("24px");
      expect(el.rules).toEqual([
        { selector: ".card", declarations: "color: rgb(0, 0, 255); margin: 10px;" },
        { selector: ".card", declarations: "padding: 24px;", within: ["@media (min-width: 600px)"] },
      ]);
      expect(el.path).toEqual([{ oid: "page", tag: "main" }]);
      expect(el.children).toEqual([
        { oid: "title", tag: "h2", text: "Hi" },
        { oid: "body", tag: "p", text: "Text" },
      ]);
      expect(el.html.startsWith('<section class="card" data-oid="card"')).toBe(true);
      expect(el.truncated).toEqual([]);

      // the mobile frame is narrower than the media query
      const mobile = parsed(await client.callTool({ name: "get_element", arguments: { project: "shop", design: "home", oid: "card", frame: "mobile" } }));
      expect(mobile.element.rules).toHaveLength(1);
      expect(mobile.element.styles["padding"]).toBe("0px");
    } finally {
      await Bun.write(join(dir, "styles.css"), "h1 { color: red; }");
      await Bun.file(join(dir, "card.html")).delete();
    }
  });

  test("long values are cut and listed; @container rules are given; many children are cut", async () => {
    const dir = designDir(ws, "shop", "home");
    const long = "x".repeat(21_000); // longer than the HTML limit too
    const kids = Array.from({ length: 120 }, (_, i) => `<i data-oid="k${i}">${i}</i>`).join("");
    await Bun.write(
      join(dir, "big.html"),
      `<html><head><style>.box { background-image: url("data:image/png;base64,${long}"); }
        .wrap { container-type: inline-size; width: 400px; }
        .box { color: black; } @container (min-width: 300px) { .box { color: red; } }</style></head>
       <body><div class="wrap"><div class="box" data-oid="box" title="${long}"><span>${"t".repeat(600)}</span>${kids}</div></div></body></html>`,
    );
    try {
      const client = await connect(true);
      const el = parsed(await client.callTool({ name: "get_element", arguments: { project: "shop", design: "home", oid: "box" } })).element;
      expect(el.attributes.title).toHaveLength(500);
      expect(el.rules[0].declarations).toHaveLength(4000);
      expect(el.rules.at(-1)).toEqual({ selector: ".box", declarations: "color: red;", within: ["@container (min-width: 300px)"] });
      expect(el.styles.color).toBe("rgb(255, 0, 0)");
      expect(el.children).toHaveLength(100);
      expect(el.styles["background-image"]).toHaveLength(500);
      expect(el.truncated.sort()).toEqual(["attributes.title", "children", "html", "rules[0].declarations", "styles.background-image", "text"]);
    } finally {
      await Bun.file(join(dir, "big.html")).delete();
    }
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
