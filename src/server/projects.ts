import { createDesign, createProject, renameDesign, renameProject, WorkspaceError } from "../workspace/projects.ts";
import { designKey, type DesignLocks } from "./locks.ts";

export interface ProjectDeps {
  workspace: string;
  locks: DesignLocks;
  /** Commits the changed paths. Returns the commit id, or null when nothing changed. */
  commit?: (paths: string[], message: string) => Promise<string | null>;
}

type Params = { project?: string; design?: string };

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (typeof b === "object" && b !== null) return b as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new WorkspaceError(400, "The body must be a JSON object.");
}

/** The change is done when the commit fails; the response then names the commit error. */
async function commit(deps: ProjectDeps, paths: string[], message: string): Promise<{ commitError?: string }> {
  if (!deps.commit || !paths.length) return {};
  try {
    await deps.commit(paths, message);
    return {};
  } catch (e) {
    const commitError = e instanceof Error ? e.message : String(e);
    console.error("Could not commit:", commitError);
    return { commitError };
  }
}

function fail(e: unknown): Response {
  if (e instanceof WorkspaceError) return Response.json({ error: e.message }, { status: e.status });
  throw e;
}

/** POST /api/projects { name, id? }: a new project with its first design, "home". */
export async function postProject(deps: ProjectDeps, req: Request): Promise<Response> {
  try {
    const b = await body(req);
    const { id, paths } = await createProject(deps.workspace, b.name, b.id);
    return Response.json({ id, design: "home", ...(await commit(deps, paths, `Create project ${String(b.name).trim()}`)) }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}

/** PATCH /api/projects/:project { name }: a new display name. */
export async function patchProject(deps: ProjectDeps, req: Request, params: Params): Promise<Response> {
  try {
    const b = await body(req);
    const { paths } = await renameProject(deps.workspace, params.project, b.name);
    return Response.json({ id: params.project, ...(await commit(deps, paths, `Rename project to ${String(b.name).trim()}`)) });
  } catch (e) {
    return fail(e);
  }
}

/** POST /api/projects/:project/designs { id, kind?: "page" | "slides" }: a new empty design or deck. */
export async function postDesign(deps: ProjectDeps, req: Request, params: Params): Promise<Response> {
  try {
    const b = await body(req);
    const { paths } = await createDesign(deps.workspace, params.project, b.id, b.kind ?? "page");
    return Response.json({ id: b.id, ...(await commit(deps, paths, `Create design ${String(b.id)}`)) }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}

/** PATCH /api/projects/:project/designs/:design { id }: moves the design and its chat. */
export async function patchDesign(deps: ProjectDeps, req: Request, params: Params): Promise<Response> {
  let b: Record<string, unknown>;
  try {
    b = await body(req);
  } catch (e) {
    return fail(e);
  }
  const project = String(params.project);
  const keys = [designKey(project, String(params.design)), designKey(project, String(b.id))];
  if (!deps.locks.tryLock(...keys)) {
    return Response.json({ error: "A turn is running for this design. Rename it when the turn ends." }, { status: 409 });
  }
  try {
    const { paths } = await renameDesign(deps.workspace, params.project, params.design, b.id);
    return Response.json({ id: b.id, ...(await commit(deps, paths, `Rename design ${params.design} to ${String(b.id)}`)) });
  } catch (e) {
    return fail(e);
  } finally {
    deps.locks.unlock(...keys);
  }
}
