import { commitModels } from "../workspace/chat.ts";
import { designLog, isSha, type Version } from "../workspace/git.ts";
import { restoreDesign } from "../workspace/history.ts";
import { designDir } from "../workspace/paths.ts";
import { designKey, DesignLocks } from "./locks.ts";

export interface HistoryDeps {
  workspace: string;
  locks: DesignLocks;
  /** Commits these paths. Returns the commit id, or null when nothing changed. */
  commit: (paths: string[], message: string) => Promise<string | null>;
}

/** A version as the API sends it, with the model of the turn that made it, when known. */
export type VersionView = Version & { model: string | null };

type Params = { project: string; design: string };

const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

async function check(workspace: string, params: Params): Promise<string | Response> {
  let dir: string;
  try {
    dir = designDir(workspace, params.project, params.design);
  } catch (e) {
    return fail((e as Error).message);
  }
  return (await Bun.file(`${dir}/index.html`).exists()) ? dir : fail("Design not found.", 404);
}

/** GET …/designs/:design/history: the versions, newest first. */
export async function getHistory(deps: HistoryDeps, params: Params): Promise<Response> {
  const dir = await check(deps.workspace, params);
  if (dir instanceof Response) return dir;
  const [log, models] = await Promise.all([
    designLog(deps.workspace, params.project, params.design),
    commitModels(deps.workspace, params.project),
  ]);
  return Response.json(log.map((v): VersionView => ({ ...v, model: models.get(v.sha) ?? null })));
}

/** POST …/designs/:design/history/:sha/restore: the design as it was then, as a new commit. */
export async function restoreVersion(deps: HistoryDeps, params: Params & { sha: string }): Promise<Response> {
  const dir = await check(deps.workspace, params);
  if (dir instanceof Response) return dir;
  if (!isSha(params.sha)) return fail("Invalid commit id.");
  const key = designKey(params.project, params.design);
  if (!deps.locks.tryLock(key)) return fail("A turn is running for this design. Wait for it to end.", 409);
  try {
    const version = (await designLog(deps.workspace, params.project, params.design)).find((v) => v.sha.startsWith(params.sha));
    if (!version) return fail("This version is not in the history of the design.", 404);
    if (!(await restoreDesign(deps.workspace, params.project, params.design, version.sha))) {
      return fail("This version has no files of the design.", 404);
    }
    const message = `Restore ${version.sha.slice(0, 7)}: ${version.message}`;
    try {
      return Response.json({ commit: await deps.commit([dir], message) });
    } catch (e) {
      return Response.json({ commit: null, commitError: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    deps.locks.unlock(key);
  }
}
