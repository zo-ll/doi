import { z } from "zod";
import { itemId } from "../architecture/nodes.ts";
import { diagramSchema } from "../architecture/schema.ts";
import { diagramSvg } from "../architecture/svg.ts";
import { ExportError } from "../export/html.ts";
import { renderPdf, renderPngs } from "../export/render.ts";
import { ArchitectureError, architecturePath } from "../workspace/architecture.ts";
import { failure, readBody } from "./architecture.ts";

/** The renderers; tests can pass their own. */
export interface DiagramRenderers { renderPngs: typeof renderPngs; renderPdf: typeof renderPdf }
const RENDERERS: DiagramRenderers = { renderPngs, renderPdf };
/** Chromium captures at most 16 384 device pixels on a side. */
export const MAX_IMAGE_SIDE = 16_000;

const exportSchema = z.strictObject({
  format: z.enum(["png", "pdf"]),
  diagram: diagramSchema,
  theme: z.enum(["dark", "light"]),
  background: z.boolean(),
  ids: z.array(itemId).max(6000).optional(),
  scale: z.union([z.literal(1), z.literal(2)]).default(1),
});

/** A safe download name from the diagram name. */
export function imageName(name: string, extension: string): string {
  const base = name.normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80) || "diagram";
  return `${base}.${extension}`;
}

/**
 * POST …/architecture/export: { format: png|pdf, diagram, theme, background, ids?, scale? }.
 * The client sends the graph it shows, so an export never waits for autosave. The server
 * validates it, renders the same SVG as the SVG export, and captures it in the sandboxed
 * Chromium of the design exports. A PDF without a background has a white page.
 */
export async function postArchitectureExport(workspace: string, project: string, req: Request, render: DiagramRenderers = RENDERERS): Promise<Response> {
  try {
    await architecturePath(workspace, project);
    const body = exportSchema.parse(await readBody(req));
    const image = diagramSvg(body.diagram, { theme: body.theme, background: body.background, ids: body.ids ? new Set(body.ids) : undefined });
    if ("error" in image) throw new ArchitectureError(400, image.error);
    const scale = body.format === "png" ? body.scale : 1;
    if (Math.max(image.width, image.height) * scale > MAX_IMAGE_SIDE) {
      throw new ArchitectureError(413, `The image would be ${Math.max(image.width, image.height) * scale} px on its long side; the limit is ${MAX_IMAGE_SIDE} px. Export a selection, use 1× or use SVG.`);
    }
    const page = body.background ? "" : body.format === "pdf" ? "background:#fff;" : "background:transparent;";
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;${page}}svg{display:block}</style></head><body>${image.svg}</body></html>`;
    const frame = { width: image.width, height: image.height };
    const bytes = body.format === "png"
      ? (await render.renderPngs(html, [frame], { scale, fullPage: false, transparent: !body.background }))[0]
      : await render.renderPdf(html, frame);
    if (!bytes) throw new ArchitectureError(500, "The renderer returned no image.");
    return new Response(new Uint8Array(bytes), { headers: {
      "content-type": body.format === "png" ? "image/png" : "application/pdf",
      "content-disposition": `attachment; filename="${imageName(body.diagram.name, body.format)}"`,
    } });
  } catch (error) {
    if (error instanceof ExportError) return Response.json({ error: error.message }, { status: error.status });
    return failure(error);
  }
}
