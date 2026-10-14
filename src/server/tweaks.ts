import { join } from "node:path";
import { readTweaks, checkVars, TweakError, withVars } from "../workspace/tweaks.ts";
import { designDir } from "../workspace/paths.ts";
import { designKey, type DesignLocks } from "./locks.ts";

export interface TweakDeps {
  workspace: string;
  locks: DesignLocks;
  /** Commits these paths. Returns the commit id, or null when nothing changed. */
  commit: (paths: string[], message: string) => Promise<string | null>;
}

type Params = { project: string; design: string };
const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

async function dirOf(workspace: string, params: Params): Promise<string | Response> {
  let dir: string;
  try {
    dir = designDir(workspace, params.project, params.design);
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!(await Bun.file(join(dir, "index.html")).exists())) return fail("Design not found.", 404);
  return dir;
}

/** GET …/designs/:design/tweaks: the controls and the values now. */
export async function getTweaks(workspace: string, params: Params): Promise<Response> {
  const dir = await dirOf(workspace, params);
  if (dir instanceof Response) return dir;
  return Response.json(await readTweaks(dir));
}

/** PUT …/designs/:design/tweaks { vars }: writes the values into styles.css and commits them as a version. */
export async function putTweaks(deps: TweakDeps, req: Request, params: Params): Promise<Response> {
  const dir = await dirOf(deps.workspace, params);
  if (dir instanceof Response) return dir;
  let vars: Record<string, string>;
  try {
    vars = checkVars(((await req.json()) as { vars?: unknown })?.vars);
  } catch (e) {
    return fail(e instanceof TweakError ? e.message : "The body must be a JSON object.");
  }
  const key = designKey(params.project, params.design);
  if (!deps.locks.tryLock(key)) return fail("A turn or a rename runs on this design. Try again when it ends.", 409);
  try {
    const path = join(dir, "styles.css");
    const file = Bun.file(path);
    if (!(await file.exists())) return fail("This design has no styles.css.", 409);
    await Bun.write(path, withVars(await file.text(), vars));
    let commit: string | null = null;
    let commitError: string | undefined;
    try {
      commit = await deps.commit([dir], `Tweaks: ${Object.keys(vars).join(", ")}`);
    } catch (e) {
      commitError = e instanceof Error ? e.message : String(e);
    }
    return Response.json({ commit, ...(commitError ? { commitError } : {}), tweaks: await readTweaks(dir) });
  } catch (e) {
    if (e instanceof TweakError) return fail(e.message, e.status);
    throw e;
  } finally {
    deps.locks.unlock(key);
  }
}
