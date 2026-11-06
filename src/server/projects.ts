import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { cloneDir } from "../github/gh.ts";
import { assertName, listProjects } from "../workspace/paths.ts";
import { createDesign, createProject, createScreen, freeProjectName, projectDir, renameDesign, renameProject, setAppKind, WorkspaceError } from "../workspace/projects.ts";
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

/**
 * POST /api/projects { name, id?, kind?, free? }: a new project with its first design, "home", of
 * that kind. With `free`, a taken name gets a number.
 */
export async function postProject(deps: ProjectDeps, req: Request): Promise<Response> {
  try {
    const b = await body(req);
    const wanted = b.free === true ? freeProjectName(deps.workspace, b.name) : { name: b.name, id: b.id };
    const { id, paths } = await createProject(deps.workspace, wanted.name, wanted.id, b.kind ?? "page");
    return Response.json({ id, design: "home", ...(await commit(deps, paths, `Create project ${String(wanted.name).trim()}`)) }, { status: 201 });
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

/** PUT /api/projects/:project/designs/:design/kind { app }: a mobile app (one phone frame per page), or a page again. */
export async function putDesignKind(deps: ProjectDeps, req: Request, params: Params): Promise<Response> {
  try {
    const b = await body(req);
    const { paths } = await setAppKind(deps.workspace, params.project, params.design, b.app);
    const what = b.app ? "a mobile app" : "a page";
    return Response.json({ app: b.app, ...(await commit(deps, paths, `Make ${String(params.design)} ${what}`)) });
  } catch (e) {
    return fail(e);
  }
}

/** POST /api/projects/:project/designs/:design/screens { name }: a new empty screen (page) of a design. */
export async function postScreen(deps: ProjectDeps, req: Request, params: Params): Promise<Response> {
  let b: Record<string, unknown>;
  try {
    b = await body(req);
  } catch (e) {
    return fail(e);
  }
  const key = designKey(String(params.project), String(params.design));
  if (!deps.locks.tryLock(key)) return Response.json({ error: "A turn is running for this design. Add the screen when it ends." }, { status: 409 });
  try {
    const { page, paths } = await createScreen(deps.workspace, params.project, params.design, b.name);
    return Response.json({ page, ...(await commit(deps, paths, `Add screen ${page}`)) }, { status: 201 });
  } catch (e) {
    return fail(e);
  } finally {
    deps.locks.unlock(key);
  }
}

/** POST /api/projects/:project/designs { id, kind?: "page" | "app" | "slides" }: a new empty design, app or deck. */
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

/**
 * DELETE /api/projects/:project: removes the project folder (designs, chat, uploads, and old variant sets)
 * and commits the removal, so the history keeps it. A linked repo's clone goes when no other
 * project links that repo. Refused while a turn runs on one of its designs.
 */
export async function deleteProject(deps: ProjectDeps, params: Params): Promise<Response> {
  const id = String(params.project);
  let dir: string;
  try {
    assertName("project", id);
    dir = projectDir(deps.workspace, id);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  const all = await listProjects(deps.workspace);
  const project = all.find((p) => p.id === id);
  if (!project || !existsSync(dir)) return Response.json({ error: `No project "${id}".` }, { status: 404 });
  const repo = project.repo?.name ?? null;
  const keys = [...project.designs.map((d) => designKey(id, d)), ...(repo ? [`repo:${repo.toLowerCase()}`] : [])];
  if (!deps.locks.tryLock(...keys)) {
    return Response.json({ error: "A turn, or a clone or update of its repo, is running. Delete the project when it ends." }, { status: 409 });
  }
  try {
    await rm(dir, { recursive: true, force: true });
    if (repo && !all.some((p) => p.id !== id && p.repo?.name.toLowerCase() === repo.toLowerCase())) {
      await rm(cloneDir(deps.workspace, repo), { recursive: true, force: true });
    }
  } finally {
    deps.locks.unlock(...keys);
  }
  return Response.json({ id, ...(await commit(deps, [dir], `Delete project ${project.name}`)) });
}
