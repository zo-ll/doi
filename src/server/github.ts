import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { cloneDir, GhError, ghDeps, ghStatus, listRepos, syncClone, viewRepo, type GhDeps } from "../github/gh.ts";
import { updateProjectMeta } from "../workspace/layout.ts";
import { assertName, linkedRepo, listProjects } from "../workspace/paths.ts";
import { projectFile } from "../workspace/project-file.ts";
import type { DesignLocks } from "./locks.ts";

export interface GithubDeps {
  workspace: string;
  locks: DesignLocks;
  /** Commits these paths. Returns the commit id, or null when nothing changed. */
  commit: (paths: string[], message: string) => Promise<string | null>;
  gh?: GhDeps;
}

type Server = Pick<Bun.Server<unknown>, "timeout">;
const fail = (message: string, status = 400) => Response.json({ error: message }, { status });
const asResponse = (e: unknown) => (e instanceof GhError ? fail(e.message, e.status) : fail(e instanceof Error ? e.message : String(e), 500));

/** GET /api/github/status: is gh there and logged in. No account detail. */
export async function getGithubStatus(deps: GithubDeps): Promise<Response> {
  return Response.json(await ghStatus(deps.gh ?? ghDeps));
}

/** GET /api/github/repos: the repos of the gh account, newest first. */
export async function getGithubRepos(deps: GithubDeps): Promise<Response> {
  try {
    return Response.json(await listRepos(deps.gh ?? ghDeps));
  } catch (e) {
    return asResponse(e);
  }
}

async function checkProject(workspace: string, project: string): Promise<Response | null> {
  try {
    assertName("project", project);
  } catch (e) {
    return fail((e as Error).message);
  }
  return existsSync(projectFile(workspace, project)) ? null : fail("Project not found.", 404);
}

/** Clones or updates the repo and stores it in project.json. One sync per repo at a time. */
async function link(deps: GithubDeps, project: string, name: string, message: string): Promise<Response> {
  const gh = deps.gh ?? ghDeps;
  const key = `repo:${name.toLowerCase()}`;
  if (!deps.locks.tryLock(key)) return fail(`${name} is being cloned or updated now.`, 409);
  try {
    const repo = await viewRepo(name, gh);
    const commit = await syncClone(deps.workspace, repo.name, gh);
    const value = { name: repo.name, commit, syncedAt: new Date().toISOString() };
    await updateProjectMeta(deps.workspace, project, (meta) => ({ ...meta, repo: value }));
    let saved: string | null = null;
    try {
      saved = await deps.commit([projectFile(deps.workspace, project)], message.replace("{name}", repo.name));
    } catch {
      // The link works without a version; the next commit of project.json takes it along.
    }
    return Response.json({ repo: value, commit: saved });
  } catch (e) {
    return asResponse(e);
  } finally {
    deps.locks.unlock(key);
  }
}

/** PUT /api/projects/:project/repo { name }: links a repo to the project, with a fresh clone. */
export async function putProjectRepo(deps: GithubDeps, req: Request, params: { project: string }, server?: Server): Promise<Response> {
  const bad = await checkProject(deps.workspace, params.project);
  if (bad) return bad;
  let name: unknown;
  try {
    name = ((await req.json()) as { name?: unknown }).name;
  } catch {
    return fail("The body must be JSON.");
  }
  if (typeof name !== "string") return fail("name must be owner/repo.");
  server?.timeout(req, 0); // a clone can take minutes
  return link(deps, params.project, name.trim(), "Link repo {name}");
}

/** POST /api/projects/:project/repo/sync: fetches the latest commit of the linked repo. */
export async function syncProjectRepo(deps: GithubDeps, req: Request, params: { project: string }, server?: Server): Promise<Response> {
  const bad = await checkProject(deps.workspace, params.project);
  if (bad) return bad;
  const meta = await Bun.file(projectFile(deps.workspace, params.project)).json().catch(() => ({}));
  const repo = linkedRepo(meta as Record<string, unknown>);
  if (!repo) return fail("This project has no linked repo.", 409);
  server?.timeout(req, 0);
  return link(deps, params.project, repo.name, "Update repo {name}");
}

/** DELETE /api/projects/:project/repo: unlinks the repo; the clone goes when no project uses it. */
export async function deleteProjectRepo(deps: GithubDeps, params: { project: string }): Promise<Response> {
  const bad = await checkProject(deps.workspace, params.project);
  if (bad) return bad;
  let name: string | null = null;
  await updateProjectMeta(deps.workspace, params.project, (meta) => {
    name = linkedRepo(meta)?.name ?? null;
    const { repo: _drop, ...rest } = meta;
    return rest;
  });
  if (name && !(await listProjects(deps.workspace)).some((p) => p.repo?.name.toLowerCase() === name!.toLowerCase())) {
    await rm(cloneDir(deps.workspace, name), { recursive: true, force: true });
  }
  let commit: string | null = null;
  try {
    commit = await deps.commit([projectFile(deps.workspace, params.project)], name ? `Unlink repo ${name}` : "Unlink repo");
  } catch {
    // as above
  }
  return Response.json({ repo: null, commit });
}
