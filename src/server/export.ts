import { ExportError, exportFolder, exportPage } from "../export/html.ts";
import { renderPdf, renderPngs } from "../export/render.ts";
import { REPORT_HEADER } from "../export/report.ts";
import { zip } from "../export/zip.ts";
import { readLayout } from "../workspace/layout.ts";
import { designDir } from "../workspace/paths.ts";

type Params = { project: string; design: string };

/** The renderers; tests pass their own, so they need no browser. */
export interface Renderers {
  renderPngs: typeof renderPngs;
  renderPdf: typeof renderPdf;
}
const RENDERERS: Renderers = { renderPngs, renderPdf };
const FORMATS = ["folder", "page", "png", "pdf"] as const;

const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

export { REPORT_HEADER };

/**
 * GET …/designs/:design/export?format=folder|page|png|pdf&oids=keep|strip&page=<file>.
 * `folder` gives a ZIP file with one folder `<design>/`; `page` gives one self-contained HTML
 * file (index.html, or `page`). `png` (&frame=<id>|all&scale=1|2&full=0|1) gives the PNG of a
 * frame, or a ZIP with one PNG per frame; `pdf` (&frame=<id>) gives a PDF of one frame (the
 * first one by default). PNG and PDF render the single-file page. All are downloads.
 */
export async function getExport(workspace: string, req: Request, params: Params, render: Renderers = RENDERERS): Promise<Response> {
  const query = new URL(req.url).searchParams;
  const format = query.get("format") ?? "folder";
  if (!(FORMATS as readonly string[]).includes(format)) return fail(`format must be one of: ${FORMATS.join(", ")}.`);
  const oids = query.get("oids") ?? "keep";
  if (oids !== "keep" && oids !== "strip") return fail('oids must be "keep" or "strip".');
  try {
    designDir(workspace, params.project, params.design);
  } catch (e) {
    return fail((e as Error).message);
  }

  const options = { stripOids: oids === "strip" };
  try {
    if (format === "folder") {
      const result = await exportFolder(workspace, params.project, params.design, options);
      const body = zip(result.files.map((f) => ({ path: `${params.design}/${f.path}`, data: f.data })));
      return download(body, "application/zip", `${params.design}.zip`, result);
    }
    const page = query.get("page") ?? undefined;
    const name = page && page !== "index.html" ? `${params.design}-${page.replace(/\.html?$/i, "").replace(/[^a-z0-9-]+/gi, "-")}` : params.design;
    if (format === "page") {
      const result = await exportPage(workspace, params.project, params.design, { ...options, page });
      return download(result.html, "text/html; charset=utf-8", `${name}.html`, result);
    }

    const frames = await readLayout(workspace, params.project, params.design);
    const frameId = query.get("frame") ?? (format === "png" ? "all" : frames[0]!.id);
    const chosen = frameId === "all" && format === "png" ? frames : frames.filter((f) => f.id === frameId);
    if (!chosen.length) return fail(`The design has no frame "${frameId}".`, 404);
    const scale = Number(query.get("scale") ?? "2");
    if (scale !== 1 && scale !== 2) return fail("scale must be 1 or 2.");
    const full = query.get("full") ?? "0";
    if (full !== "0" && full !== "1") return fail("full must be 0 or 1.");

    // The page renders with every local file inline; data-oid attributes do not change the picture.
    const result = await exportPage(workspace, params.project, params.design, { ...options, page });
    if (format === "pdf") {
      const pdf = await render.renderPdf(result.html, chosen[0]!);
      return download(new Uint8Array(pdf), "application/pdf", `${name}-${chosen[0]!.id}.pdf`, result);
    }
    const pngs = await render.renderPngs(result.html, chosen, { scale, fullPage: full === "1" });
    if (frameId !== "all") return download(new Uint8Array(pngs[0]!), "image/png", `${name}-${chosen[0]!.id}.png`, result);
    const files = chosen.map((f, i) => ({ path: `${name}-${f.id}.png`, data: new Uint8Array(pngs[i]!) }));
    return download(zip(files), "application/zip", `${name}-png.zip`, result);
  } catch (e) {
    if (e instanceof ExportError) return fail(e.message, e.status);
    throw e;
  }
}

export function download(body: BodyInit, type: string, filename: string, report: { missing: string[]; warnings: string[] }): Response {
  return new Response(body, {
    headers: {
      "content-type": type,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      [REPORT_HEADER]: encodeURIComponent(JSON.stringify({ missing: report.missing, warnings: report.warnings })),
    },
  });
}
