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
import { ArchitectureError, readArchitecture, writeArchitecture } from "../workspace/architecture.ts";
import { checkpointArchitecture } from "../workspace/architecture-history.ts";
import { diagramSchema } from "../architecture/schema.ts";
import { diagramSvg, imageText, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE } from "../architecture/svg.ts";
import { architectureErrorMessage } from "../architecture/errors.ts";
import { diagramFontCss } from "../export/diagram-fonts.ts";
import { readComments } from "../workspace/comments.ts";
import { activeDesignSystem, designSystemDir } from "../workspace/design-systems.ts";
import { designFrames, isApp } from "../workspace/layout.ts";
import { assertName, designDir, listProjects } from "../workspace/paths.ts";

/**
 * The doi MCP server (#54): any coding agent with an MCP client reads the designs through it.
 * It is served by the doi server at `/mcp` (Streamable HTTP, stateless), so it needs no setup
 * per agent. The tools read, except two: `export_png` and `render_architecture` render, and
 * `update_architecture` writes one UML diagram with the editor's validation and revision check.
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

/** The project's UML, which the user must have enabled; a bad project name is a tool error. */
async function readUml(workspace: string, project: string) {
  assertName("project", project);
  const view = await readArchitecture(workspace, project);
  if (!view.state.enabled) throw new ToolError("UML is not enabled in this project. Ask the user to add UML in doi (right panel → UML).");
  return view;
}
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
    "get_architecture",
    {
      description: "Reads the optional UML diagrams of a project, including the versioned graph, stable item ids, UI links and file revision. This does not create or enable UML.",
      inputSchema: { project: projectArg },
      annotations: { readOnlyHint: true },
    },
    ({ project }) => tool(async () => json(await readArchitecture(workspace, project))),
  );

  server.registerTool(
    "render_architecture",
    {
      description: "Renders one UML diagram of a project as a PNG, as doi's image export draws it. Use it to see the diagram.",
      inputSchema: {
        project: projectArg,
        diagram: z.string().optional().describe("The diagram id or name from get_architecture. Default: the first diagram."),
        theme: z.enum(["dark", "light"]).optional().describe("The colours. Default: light."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ project, diagram, theme }) =>
      tool(async () => {
        const { state } = await readUml(workspace, project);
        const chosen = diagram ? state.diagrams.find(d => d.id === diagram || d.name === diagram) : state.diagrams[0];
        if (!chosen) throw new ToolError(diagram ? `Diagram "${diagram}" not found. Diagrams: ${state.diagrams.map(d => `${d.name} (${d.id})`).join(", ")}.` : "The project has no UML diagram.");
        const image = diagramSvg(chosen, { theme: theme ?? "light", background: true, fontCss: await diagramFontCss(imageText(chosen)) });
        if ("error" in image) throw new ToolError(image.error);
        if (Math.max(image.width, image.height) > MAX_IMAGE_SIDE || image.width * image.height > MAX_IMAGE_PIXELS) throw new ToolError(`The diagram is ${image.width} × ${image.height} px, larger than an image can be. Read it with get_architecture.`);
        const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}svg{display:block}</style></head><body>${image.svg}</body></html>`;
        let png: Buffer;
        try {
          [png] = (await (deps.render ?? renderPngs)(html, [image], { scale: 1, fullPage: false })) as [Buffer];
        } catch (e) {
          throw renderError(e);
        }
        return {
          content: [
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
            { type: "text", text: `${chosen.name} (${chosen.id}): ${chosen.nodes.length} boxes, ${chosen.edges.length} connectors, ${image.width} × ${image.height}.` },
          ],
        };
      }),
  );

  server.registerTool(
    "update_architecture",
    {
      description:
        "Creates or replaces one UML diagram of a project. Send the whole diagram in the get_architecture format, with the revision that get_architecture gave. " +
        "doi checks it as its editor does: unique ids, connectors between existing boxes, groups without cycles, limits. A changed revision means that someone else saved first: " +
        "call get_architecture again and merge. Keep the ids of items that stay, so comments and UI links stay attached. UML must be enabled in the project (the user does this in doi). " +
        "The open editor in doi shows the change at once. doi records the change as a version.",
      inputSchema: {
        project: projectArg,
        revision: z.string().nullable().describe("The revision from get_architecture."),
        diagram: z.unknown().describe("One diagram: { id, name, nodes, edges, comments }, as get_architecture returns it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ project, revision, diagram }) =>
      tool(async () => {
        const parsed = diagramSchema.safeParse(diagram);
        if (!parsed.success) throw new ToolError(`The diagram is invalid. ${architectureErrorMessage(parsed.error)}`);
        const current = await readUml(workspace, project);
        const exists = current.state.diagrams.some(d => d.id === parsed.data.id);
        const diagrams = exists ? current.state.diagrams.map(d => d.id === parsed.data.id ? parsed.data : d) : [...current.state.diagrams, parsed.data];
        let saved;
        try {
          saved = await writeArchitecture(workspace, project, revision, { ...current.state, diagrams });
        } catch (e) {
          if (e instanceof ArchitectureError) throw new ToolError(e.status === 409 ? "The UML changed since that revision. Call get_architecture again, merge your change and send the new revision." : e.message);
          if (e instanceof z.ZodError) {
            if (e.issues.some(issue => issue.path.length === 1 && issue.path[0] === "diagrams")) throw new ToolError("A project can have at most 50 UML diagrams. Replace a diagram instead of adding one.");
            throw new ToolError(`The UML is invalid. ${architectureErrorMessage(e)}`);
          }
          throw new ToolError(`The UML could not be saved: ${e instanceof Error ? e.message : String(e)}`);
        }
        const version = await checkpointArchitecture(workspace, project, `agent: ${parsed.data.name}`);
        return json({ revision: saved.revision, diagram: parsed.data.id, created: !exists, version: version.sha });
      }),
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
          frames: (await designFrames(workspace, project, design)).map(({ id, label, width, height }) => ({ id, label, width, height })),
          designSystem: ds?.name ?? null,
          // A mobile app: each page is one phone screen (the "phone" frame).
          ...((await isApp(workspace, project, design)) ? { kind: "app" } : {}),
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
        const frames = await designFrames(workspace, project, design);
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
        "Use it for an element that a comment or a request names. A doi node link (http://127.0.0.1:<port>/?project=…&design=…&page=…&node=…, " +
        "copied from doi's side panel) gives these arguments: node is the oid; no page means index.html; page may be URL-encoded (doi decodes it).",
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
        // A page copied from a node link can still be URL-encoded (docs%2Fnested.html).
        if (page && /%[0-9A-Fa-f]{2}/.test(page)) {
          try {
            page = decodeURIComponent(page);
          } catch {}
        }
        let chosenPage = page;
        for (const f of page ? [] : pages) {
          if ((await designOids([f])).has(oid)) {
            chosenPage = f.path;
            break;
          }
        }
        if (!chosenPage) throw new ToolError(`No page of "${project}/${design}" has data-oid "${oid}". Call get_design or get_comments.`);
        const frames = await designFrames(workspace, project, design);
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
