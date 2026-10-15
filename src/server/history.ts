import { commitModels } from "../workspace/chat.ts";
import { checkoutBefore, deletedFolders, designLog, isSha, type Version } from "../workspace/git.ts";
import { restoreDesign } from "../workspace/history.ts";
import { designDir } from "../workspace/paths.ts";
import { openSet, setDir, variantsRoot } from "../workspace/variants.ts";
import { designKey, DesignLocks } from "./locks.ts";

export interface HistoryDeps {
  workspace: string;
  locks: DesignLocks;
  /** True when the design has open variants. */
  variantsOpen: (params: Params) => Promise<boolean>;
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
  if (await deps.variantsOpen(params)) return fail("This design has open variants. Pick one or discard them first.", 409);
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

const PICK = /^Pick variant \d+: /;

/**
 * POST …/designs/:design/history/:sha/reopen-variants: brings back the variant set that the
 * pick `sha` removed, as it was before the pick, and commits it. The design does not change:
 * a new pick replaces it.
 */
export async function reopenVariants(deps: HistoryDeps, params: Params & { sha: string }): Promise<Response> {
  const dir = await check(deps.workspace, params);
  if (dir instanceof Response) return dir;
  if (!isSha(params.sha)) return fail("Invalid commit id.");
  if (await deps.variantsOpen(params)) return fail("This design has open variants. Pick one or discard them first.", 409);
  const key = designKey(params.project, params.design);
  if (!deps.locks.tryLock(key)) return fail("A turn is running for this design. Wait for it to end.", 409);
  try {
    const version = (await designLog(deps.workspace, params.project, params.design)).find((v) => v.sha.startsWith(params.sha));
    if (!version) return fail("This version is not in the history of the design.", 404);
    if (!PICK.test(version.message)) return fail("This version is not a variant pick.");
    const root = variantsRoot(deps.workspace, params.project, params.design);
    const [set] = await deletedFolders(deps.workspace, version.sha, root);
    let folder: string;
    try {
      folder = setDir(deps.workspace, params.project, params.design, set ?? "");
    } catch {
      return fail("The history has no variants for this pick.", 404);
    }
    try {
      await checkoutBefore(deps.workspace, version.sha, folder);
    } catch (e) {
      return fail(`The variants cannot come back: ${e instanceof Error ? e.message : String(e)}`, 500);
    }
    const reopened = await openSet(deps.workspace, params.project, params.design);
    const message = `Reopen variants: ${reopened?.prompt ?? version.message.replace(PICK, "")}`;
    try {
      return Response.json({ set: set, commit: await deps.commit([folder], message) });
    } catch (e) {
      return Response.json({ set: set, commit: null, commitError: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    deps.locks.unlock(key);
  }
}
