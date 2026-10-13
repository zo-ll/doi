import { ExportError } from "../export/html.ts";
import { renderPngs } from "../export/render.ts";
import { zip } from "../export/zip.ts";
import { buildBundle, draftHandoff, HANDOFF_TEMPLATE } from "../handoff/bundle.ts";
import { CommentError } from "../workspace/comments.ts";
import { assertName } from "../workspace/paths.ts";
import { download } from "./export.ts";

type Params = { project: string; design: string };

const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

async function run(params: Params, job: () => Promise<Response>): Promise<Response> {
  try {
    assertName("project", params.project);
    assertName("design", params.design);
  } catch (e) {
    return fail((e as Error).message);
  }
  try {
    return await job();
  } catch (e) {
    if (e instanceof ExportError || e instanceof CommentError) return fail(e.message, e.status);
    throw e;
  }
}

/** GET …/designs/:design/handoff: the HANDOFF.md draft from the template, for the user to edit. */
export function getHandoff(workspace: string, params: Params): Promise<Response> {
  return run(params, async () =>
    Response.json({ markdown: await draftHandoff(workspace, params.project, params.design), template: HANDOFF_TEMPLATE.version }),
  );
}

/**
 * POST …/designs/:design/handoff/bundle { markdown }: the bundle with the user's HANDOFF.md, as
 * a ZIP file with one folder `<design>-handoff/`.
 */
export function postBundle(workspace: string, req: Request, params: Params, render: typeof renderPngs = renderPngs): Promise<Response> {
  return run(params, async () => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail("The body must be a JSON object.");
    }
    const markdown = typeof body === "object" && body !== null ? (body as Record<string, unknown>).markdown : undefined;
    const bundle = await buildBundle(workspace, params.project, params.design, markdown, render);
    const root = `${params.design}-handoff`;
    const archive = zip(bundle.files.map((f) => ({ path: `${root}/${f.path}`, data: f.data })));
    return download(archive, "application/zip", `${root}.zip`, bundle);
  });
}
