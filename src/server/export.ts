import { ExportError, exportFolder, exportPage } from "../export/html.ts";
import { REPORT_HEADER } from "../export/report.ts";
import { zip } from "../export/zip.ts";
import { designDir } from "../workspace/paths.ts";

type Params = { project: string; design: string };

const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

export { REPORT_HEADER };

/**
 * GET …/designs/:design/export?format=folder|page&oids=keep|strip&page=<file>.
 * `folder` gives a ZIP file with one folder `<design>/`; `page` gives one self-contained HTML
 * file (index.html, or `page`). Both are downloads, never shown as a page.
 */
export async function getExport(workspace: string, req: Request, params: Params): Promise<Response> {
  const query = new URL(req.url).searchParams;
  const format = query.get("format") ?? "folder";
  if (format !== "folder" && format !== "page") return fail('format must be "folder" or "page".');
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
    const result = await exportPage(workspace, params.project, params.design, { ...options, page });
    const name = page && page !== "index.html" ? `${params.design}-${page.replace(/\.html?$/i, "").replace(/[^a-z0-9-]+/gi, "-")}` : params.design;
    return download(result.html, "text/html; charset=utf-8", `${name}.html`, result);
  } catch (e) {
    if (e instanceof ExportError) return fail(e.message, e.status);
    throw e;
  }
}

function download(body: BodyInit, type: string, filename: string, report: { missing: string[]; warnings: string[] }): Response {
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
