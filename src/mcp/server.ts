import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { exportPage } from "../export/html.ts";
import { inspectRender, renderPngs } from "../export/render.ts";
import { readDesignFiles } from "../generation/context.ts";
import { designOids } from "../generation/oids.ts";
import { readElement, type ElementInfo } from "./element.ts";
import { readChat } from "../workspace/chat.ts";
import { readComments } from "../workspace/comments.ts";
import { activeDesignSystem, designSystemDir } from "../workspace/design-systems.ts";
import { readLayout } from "../workspace/layout.ts";
import { assertName, designDir, listProjects } from "../workspace/paths.ts";

/**
 * The doi MCP server (#54): any coding agent with an MCP client reads the designs through it.
 * It is served by the doi server at `/mcp` (Streamable HTTP, stateless), so it needs no setup
 * per agent. All tools only read, except that `export_png` renders a page.
 */
export const MCP_PATH = "/mcp";
const MAX_REQUESTS = 20;
/** Text of all files in one get_design answer; a larger design names the files it left out. */
const MAX_DESIGN_CHARS = 400_000;

export interface McpDeps {
  workspace: string;
  /** Renders PNGs; tests pass their own. */
  render?: typeof renderPngs;
  /** Reads one element from a rendered page; tests pass their own. */
  inspect?: (html: string, frame: { width: number; height: number }, oid: string) => Promise<ElementInfo | null>;
}

const OID = /^[A-Za-z0-9_-]{1,100}$/;

/** The real inspector: Chromium renders the page, then readElement() runs in it. */
const inspectInChromium: NonNullable<McpDeps["inspect"]> = (html, frame, oid) => inspectRender(html, frame, (page) => page.evaluate(readElement, oid));

/** A missing Chromium gets the install hint; other errors pass through. */
function renderError(e: unknown): ToolError {
  const text = e instanceof Error ? e.message : String(e);
  return new ToolError(/Executable doesn't exist|Chromium for Playwright is not installed/i.test(text) ? "doi has no Chromium. Run `doi install-browser` (from the source: `bun run install-browser`)." : text);
}

class ToolError extends Error {}

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

/** Runs a tool; a bad name or a missing design becomes a tool error, not a protocol error. */
async function tool(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
  }
}

async function checkDesign(workspace: string, project: string, design: string): Promise<string> {
  assertName("project", project);
  assertName("design", design);
  const dir = designDir(workspace, project, design);
  if (!(await Bun.file(`${dir}/index.html`).exists())) throw new ToolError(`Design "${project}/${design}" not found. Call list_designs.`);
  return dir;
}

const projectArg = z.string().describe("The project id from list_designs.");
const designArg = z.string().describe("The design id from list_designs.");

export function createMcpServer(deps: McpDeps): McpServer {
  const { workspace } = deps;
  const server = new McpServer({ name: "doi", version: "1.0.0" });

  server.registerTool(
    "list_designs",
    {
      description: "Lists the doi projects, their designs and the design system of each project.",
      annotations: { readOnlyHint: true },
    },
    () => tool(async () => json({ projects: await listProjects(workspace) })),
  );

  server.registerTool(
    "get_design",
    {
      description:
        "Gets one design: its HTML and CSS files, pages, frames (viewport sizes), the user's recent requests and the folder on disk. " +
        "Elements carry data-oid attributes; comments name elements by them. Links to /ds/<name>/ are design system files (get_design_system).",
      inputSchema: { project: projectArg, design: designArg },
      annotations: { readOnlyHint: true },
    },
    ({ project, design }) =>
      tool(async () => {
        const dir = await checkDesign(workspace, project, design);
        const files = await readDesignFiles(dir);
        let budget = MAX_DESIGN_CHARS;
        const left: string[] = [];
        const out = files.map((f) => {
          if (f.content === null) return { path: f.path, binary: true };
          if (f.content.length > budget) {
            left.push(f.path);
            return { path: f.path, content: null, omitted: "too large for one answer; read it from the folder" };
          }
          budget -= f.content.length;
          return { path: f.path, content: f.content };
        });
        const requests = (await readChat(workspace, project, design))
          .filter((e) => e.role === "user")
          .slice(-MAX_REQUESTS)
          .map((e) => ({ text: e.text, element: e.target }));
        const ds = await activeDesignSystem(workspace, project);
        return json({
          project,
          design,
          folder: dir,
          pages: files.map((f) => f.path).filter((p) => /\.html?$/i.test(p)),
          frames: (await readLayout(workspace, project, design)).map(({ id, label, width, height }) => ({ id, label, width, height })),
          designSystem: ds?.name ?? null,
          requests,
          files: out,
          ...(left.length ? { omitted: left } : {}),
        });
      }),
  );

  server.registerTool(
    "get_design_system",
    {
      description: "Gets the design system of a project: tokens.css, components.html, components.css and rules.md. Null when the project has none.",
      inputSchema: { project: projectArg },
      annotations: { readOnlyHint: true },
    },
    ({ project }) =>
      tool(async () => {
        assertName("project", project);
        const ds = await activeDesignSystem(workspace, project);
        if (!ds) return json({ designSystem: null });
        return json({
          designSystem: ds.name,
          folder: designSystemDir(workspace, ds.name),
          tokens: ds.tokens,
          components: ds.components,
          componentStyles: ds.componentStyles,
          rules: ds.rules,
          fonts: ds.fonts,
        });
      }),
  );

  server.registerTool(
    "get_comments",
    {
      description:
        "Gets the user's comments on a design. Each names an element by its data-oid; detached is true when that element is not in the design now.",
      inputSchema: { project: projectArg, design: designArg, all: z.boolean().optional().describe("Also the comments that are done.") },
      annotations: { readOnlyHint: true },
    },
    ({ project, design, all }) =>
      tool(async () => {
        const dir = await checkDesign(workspace, project, design);
        const oids = await designOids(await readDesignFiles(dir));
        const comments = (await readComments(workspace, project, design)).filter((c) => all || c.status === "open");
        return json({ comments: comments.map((c) => ({ id: c.id, element: c.oid, text: c.text, status: c.status, detached: !oids.has(c.oid) })) });
      }),
  );

  server.registerTool(
    "export_png",
    {
      description: "Renders one page of a design in one frame as a PNG of the whole page. Use it to see the design.",
      inputSchema: {
        project: projectArg,
        design: designArg,
        page: z.string().optional().describe("The page, for example about.html. Default: index.html."),
        frame: z.string().optional().describe("The frame id from get_design. Default: the first frame."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ project, design, page, frame }) =>
      tool(async () => {
        await checkDesign(workspace, project, design);
        const frames = await readLayout(workspace, project, design);
        const chosen = frame ? frames.find((f) => f.id === frame) : frames[0];
        if (!chosen) throw new ToolError(`Frame "${frame}" not found. Frames: ${frames.map((f) => f.id).join(", ")}.`);
        const result = await exportPage(workspace, project, design, { stripOids: false, ...(page ? { page } : {}) });
        let png: Buffer;
        try {
          [png] = (await (deps.render ?? renderPngs)(result.html, [chosen], { scale: 1, fullPage: true })) as [Buffer];
        } catch (e) {
          throw renderError(e);
        }
        return {
          content: [
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
            { type: "text", text: `${page ?? "index.html"} in the frame ${chosen.label}, ${chosen.width} × ${chosen.height}.` },
          ],
        };
      }),
  );

  server.registerTool(
    "get_element",
    {
      description:
        "Gets one element of a design by its data-oid, as the browser renders it in one frame: tag, attributes, text, HTML, " +
        "box (CSS px from the page's top left), computed styles, the CSS rules that match it, its ancestors and its nearest children with a data-oid. " +
        "Use it for an element that a comment or a request names.",
      inputSchema: {
        project: projectArg,
        design: designArg,
        oid: z.string().describe("The element's data-oid, for example from get_comments."),
        page: z.string().optional().describe("The page. Default: the page that has the element."),
        frame: z.string().optional().describe("The frame id from get_design. Default: the first frame."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ project, design, oid, page, frame }) =>
      tool(async () => {
        if (!OID.test(oid)) throw new ToolError("A data-oid has only letters, digits, - and _.");
        const dir = await checkDesign(workspace, project, design);
        const pages = (await readDesignFiles(dir)).filter((f) => f.content !== null && /\.html?$/i.test(f.path));
        // The HTML parser, not a text search: a data-oid in a comment, a script or text does not count.
        let chosenPage = page;
        for (const f of page ? [] : pages) {
          if ((await designOids([f])).has(oid)) {
            chosenPage = f.path;
            break;
          }
        }
        if (!chosenPage) throw new ToolError(`No page of "${project}/${design}" has data-oid "${oid}". Call get_design or get_comments.`);
        const frames = await readLayout(workspace, project, design);
        const chosen = frame ? frames.find((f) => f.id === frame) : frames[0];
        if (!chosen) throw new ToolError(`Frame "${frame}" not found. Frames: ${frames.map((f) => f.id).join(", ")}.`);
        const result = await exportPage(workspace, project, design, { stripOids: false, page: chosenPage });
        let info: ElementInfo | null;
        try {
          info = await (deps.inspect ?? inspectInChromium)(result.html, chosen, oid);
        } catch (e) {
          throw renderError(e);
        }
        if (!info) throw new ToolError(`${chosenPage} has no element with data-oid "${oid}".`);
        return json({ page: chosenPage, frame: { id: chosen.id, label: chosen.label, width: chosen.width, height: chosen.height }, element: info });
      }),
  );

  return server;
}

/** Handles one HTTP request at /mcp. Stateless: one server and transport per request. */
export async function handleMcp(deps: McpDeps, req: Request): Promise<Response> {
  const server = createMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}
