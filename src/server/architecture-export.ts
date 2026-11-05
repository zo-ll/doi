import { z } from "zod";
import { itemId } from "../architecture/nodes.ts";
import { diagramSchema } from "../architecture/schema.ts";
import { diagramSvg } from "../architecture/svg.ts";
import { diagramFontCss } from "../export/diagram-fonts.ts";
import { ExportError } from "../export/html.ts";
import { renderPdf, renderPngs } from "../export/render.ts";
import { ArchitectureError, architecturePath } from "../workspace/architecture.ts";
import { failure, readBody } from "./architecture.ts";

/** The renderers; tests can pass their own. */
export interface DiagramRenderers { renderPngs: typeof renderPngs; renderPdf: typeof renderPdf }
const RENDERERS: DiagramRenderers = { renderPngs, renderPdf };
/** Chromium captures at most 16 384 device pixels on a side; the area bound keeps a capture near 256 MB of RGBA. */
export const MAX_IMAGE_SIDE = 16_000, MAX_IMAGE_PIXELS = 64_000_000;

const exportSchema = z.strictObject({
  format: z.enum(["svg", "png", "pdf"]),
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
 * POST …/architecture/export: { format: svg|png|pdf, diagram, theme, background, ids?, scale? }.
 * The client sends the graph it shows, so an export never waits for autosave. The server
 * validates it and renders one SVG with the app fonts embedded. SVG returns that file; PNG and
 * PDF capture it in the sandboxed Chromium of the design exports. A PDF without a background
 * has a white page.
 */
export async function postArchitectureExport(workspace: string, project: string, req: Request, render: DiagramRenderers = RENDERERS): Promise<Response> {
  try {
    await architecturePath(workspace, project);
    const body = exportSchema.parse(await readBody(req));
    const image = diagramSvg(body.diagram, { theme: body.theme, background: body.background, ids: body.ids ? new Set(body.ids) : undefined, fontCss: await diagramFontCss() });
    if ("error" in image) throw new ArchitectureError(400, image.error);
    if (body.format === "svg") return new Response(image.svg, { headers: { "content-type": "image/svg+xml; charset=utf-8", "content-disposition": `attachment; filename="${imageName(body.diagram.name, "svg")}"` } });
    const scale = body.format === "png" ? body.scale : 1;
    const side = Math.max(image.width, image.height) * scale, area = image.width * image.height * scale * scale;
    if (side > MAX_IMAGE_SIDE || area > MAX_IMAGE_PIXELS) {
      const advice = body.format === "png" && scale === 2 ? "Export a selection, use 1× or use SVG." : "Export a selection or use SVG.";
      throw new ArchitectureError(413, `The image would be ${image.width * scale} × ${image.height * scale} px; the limit is ${MAX_IMAGE_SIDE} px on a side and ${MAX_IMAGE_PIXELS / 1_000_000} million pixels. ${advice}`);
    }
    const page = body.background ? "" : body.format === "pdf" ? "background:#fff;" : "background:transparent;";
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;${page}}svg{display:block}</style></head><body>${image.svg}</body></html>`;
    const frame = { width: image.width, height: image.height };
    let bytes: Buffer | undefined;
    try {
      bytes = body.format === "png"
        ? (await render.renderPngs(html, [frame], { scale, fullPage: false, transparent: !body.background }))[0]
        : await render.renderPdf(html, frame);
    } catch (error) {
      if (error instanceof ExportError) throw error;
      console.error("UML image render failed:", error);
      throw new ArchitectureError(500, "The browser could not make the image. Try again, or export SVG.");
    }
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
