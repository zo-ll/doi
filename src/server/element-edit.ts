import { join } from "node:path";
import { checkStyle, EditError, moveElement, OID, spacingScale, withElementStyle, type ElementStyle, type Position } from "../workspace/element-edit.ts";
import { activeDesignSystem } from "../workspace/design-systems.ts";
import { designLog, isSha } from "../workspace/git.ts";
import { restoreDesign } from "../workspace/history.ts";
import { designDir, designFile } from "../workspace/paths.ts";
import { designKey, type DesignLocks } from "./locks.ts";

export interface EditDeps {
  workspace: string;
  locks: DesignLocks;
  /** True when the design has open variants. */
  variantsOpen: (params: Params) => Promise<boolean>;
  /** Commits these paths. Returns the commit id, or null when nothing changed. */
  commit: (paths: string[], message: string) => Promise<string | null>;
}

type Params = { project: string; design: string };
const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

/** Commit messages of direct edits start with this; only such a commit can be undone. */
export const EDIT_PREFIX = "Edit ";

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

/** GET …/designs/:design/spacing: the scale that resizes and nudges snap to. */
export async function getSpacing(workspace: string, params: Params): Promise<Response> {
  const dir = await dirOf(workspace, params);
  if (dir instanceof Response) return dir;
  const css = Bun.file(join(dir, "styles.css"));
  const ds = await activeDesignSystem(workspace, params.project).catch(() => null);
  const sheets = [(await css.exists()) ? await css.text() : "", ds?.tokens ?? ""];
  return Response.json(spacingScale(sheets));
}

type EditBody =
  | { oid: string; style: ElementStyle }
  | { oid: string; move: { target: string; position: Position; page: string } };

function parseBody(raw: unknown): EditBody {
  const b = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof b.oid !== "string" || !OID.test(b.oid)) throw new EditError("oid must be an element id.");
  if (("style" in b) === ("move" in b)) throw new EditError("Send style or move.");
  if ("style" in b) return { oid: b.oid, style: checkStyle(b.style) };
  const m = (typeof b.move === "object" && b.move !== null ? b.move : {}) as Record<string, unknown>;
  if (typeof m.target !== "string" || !OID.test(m.target)) throw new EditError("move.target must be an element id.");
  if (m.position !== "before" && m.position !== "after") throw new EditError('move.position must be "before" or "after".');
  const page = typeof m.page === "string" ? m.page : "index.html";
  if (!/\.html?$/i.test(page)) throw new EditError("move.page must be an HTML page.");
  return { oid: b.oid, move: { target: m.target, position: m.position, page } };
}

/** "width 320px, margin-top var(--space-2)"; a removed property is "no width". */
const describeStyle = (style: ElementStyle) =>
  Object.entries(style)
    .map(([p, v]) => (v === null ? `no ${p}` : `${p} ${v}`))
    .join(", ");

/**
 * POST …/designs/:design/edit { oid, style } or { oid, move: { target, position, page } }:
 * one direct edit, committed as one version "Edit <oid>: …".
 */
export async function postEdit(deps: EditDeps, req: Request, params: Params): Promise<Response> {
  const dir = await dirOf(deps.workspace, params);
  if (dir instanceof Response) return dir;
  let body: EditBody;
  try {
    body = parseBody(await req.json().catch(() => null));
  } catch (e) {
    return fail(e instanceof EditError ? e.message : "The body must be a JSON object.");
  }
  if (await deps.variantsOpen(params)) return fail("This design has open variants. Pick one or discard them first.", 409);
  const key = designKey(params.project, params.design);
  if (!deps.locks.tryLock(key)) return fail("A turn or a rename runs on this design. Try again when it ends.", 409);
  try {
    let path: string;
    let message: string;
    if ("style" in body) {
      path = join(dir, "styles.css");
      const file = Bun.file(path);
      if (!(await file.exists())) return fail("This design has no styles.css.", 409);
      const before = await file.text();
      const after = withElementStyle(before, body.oid, body.style);
      if (after === before) return Response.json({ commit: null });
      await Bun.write(path, after);
      message = `${EDIT_PREFIX}${body.oid}: ${describeStyle(body.style)}`;
    } else {
      const file = designFile(deps.workspace, params.project, params.design, body.move.page);
      if (!file || !(await Bun.file(file).exists())) return fail("Page not found.", 404);
      path = file;
      await Bun.write(path, await moveElement(await Bun.file(path).text(), body.oid, body.move.target, body.move.position));
      message = `${EDIT_PREFIX}${body.oid}: move ${body.move.position} ${body.move.target}`;
    }
    try {
      return Response.json({ commit: await deps.commit([dir], message) });
    } catch (e) {
      return Response.json({ commit: null, commitError: e instanceof Error ? e.message : String(e) });
    }
  } catch (e) {
    if (e instanceof EditError) return fail(e.message, e.status);
    throw e;
  } finally {
    deps.locks.unlock(key);
  }
}

/**
 * POST …/designs/:design/edit/undo { commit }: puts the design back as it was before the
 * direct edit `commit`, as a new version. Only the newest version of the design can be undone.
 */
export async function undoEdit(deps: EditDeps, req: Request, params: Params): Promise<Response> {
  const dir = await dirOf(deps.workspace, params);
  if (dir instanceof Response) return dir;
  const sha = ((await req.json().catch(() => null)) as { commit?: unknown } | null)?.commit;
  if (typeof sha !== "string" || !isSha(sha)) return fail("commit must be a commit id.");
  if (await deps.variantsOpen(params)) return fail("This design has open variants. Pick one or discard them first.", 409);
  const key = designKey(params.project, params.design);
  if (!deps.locks.tryLock(key)) return fail("A turn or a rename runs on this design. Try again when it ends.", 409);
  try {
    const [last, before] = await designLog(deps.workspace, params.project, params.design, 2);
    if (!last || !last.sha.startsWith(sha) || !last.message.startsWith(EDIT_PREFIX)) {
      return fail("The design changed after this edit. Use History to restore an older version.", 409);
    }
    if (!before || !(await restoreDesign(deps.workspace, params.project, params.design, before.sha))) {
      return fail("There is no version before this edit.", 409);
    }
    try {
      return Response.json({ commit: await deps.commit([dir], `Undo ${last.message}`) });
    } catch (e) {
      return Response.json({ commit: null, commitError: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    deps.locks.unlock(key);
  }
}
