import { parseLayout, readLayout, writeLayout } from "../workspace/layout.ts";
import { designDir } from "../workspace/paths.ts";

type Params = { project: string; design: string };

const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

async function check(workspace: string, params: Params): Promise<Response | null> {
  let dir: string;
  try {
    dir = designDir(workspace, params.project, params.design);
  } catch (e) {
    return fail((e as Error).message);
  }
  return (await Bun.file(`${dir}/index.html`).exists()) ? null : fail("Design not found.", 404);
}

/** GET …/designs/:design/layout: the frames of the design on the canvas. */
export async function getLayout(workspace: string, params: Params): Promise<Response> {
  return (await check(workspace, params)) ?? Response.json(await readLayout(workspace, params.project, params.design));
}

/**
 * PUT …/designs/:design/layout { frames }. Stored in project.json. A layout change is not a
 * design version, so it makes no commit; the next commit of project.json takes it along.
 */
export async function putLayout(workspace: string, req: Request, params: Params): Promise<Response> {
  const error = await check(workspace, params);
  if (error) return error;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("The body must be JSON.");
  }
  const frames = parseLayout((body as { frames?: unknown } | null)?.frames);
  if (typeof frames === "string") return fail(frames);
  await writeLayout(workspace, params.project, params.design, frames);
  return Response.json(frames);
}
