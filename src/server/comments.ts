import { readDesignFiles } from "../generation/context.ts";
import { designOids } from "../generation/oids.ts";
import {
  addComment,
  CommentError,
  deleteComment,
  MAX_COMMENT,
  readComments,
  updateComment,
  type Comment,
} from "../workspace/comments.ts";
import { designDir } from "../workspace/paths.ts";

export interface CommentDeps {
  workspace: string;
  /** The last commit of the design, stored with a new comment. */
  version: (project: string, design: string) => Promise<string | null>;
}

/** A comment as the API sends it: `detached` when its element is not in the design now. */
export type CommentView = Comment & { detached: boolean };

type Params = { project: string; design: string };

/** Same form as a turn target, so a comment's element can be a target. */
const OID = /^[A-Za-z0-9_-]{1,100}$/;

const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

/** Checks the names and that the design exists. Returns its folder, or an error response. */
async function design(workspace: string, params: Params): Promise<string | Response> {
  let dir: string;
  try {
    dir = designDir(workspace, params.project, params.design);
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!(await Bun.file(`${dir}/index.html`).exists())) return fail("Design not found.", 404);
  return dir;
}

function text(raw: unknown): string | Response {
  if (typeof raw !== "string" || !raw.trim()) return fail("text must be a non-empty string.");
  if (raw.length > MAX_COMMENT) return fail(`text must be at most ${MAX_COMMENT} characters.`);
  return raw.trim();
}

async function body(req: Request): Promise<Record<string, unknown> | Response> {
  try {
    const data = await req.json();
    if (typeof data === "object" && data !== null && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    // fall through
  }
  return fail("The body must be a JSON object.");
}

async function run(job: () => Promise<Response>): Promise<Response> {
  try {
    return await job();
  } catch (e) {
    if (e instanceof CommentError) return fail(e.message, e.status);
    throw e;
  }
}

/** GET …/comments: all comments of the design, with `detached`. */
export function getComments(deps: CommentDeps, params: Params): Promise<Response> {
  return run(async () => {
    const dir = await design(deps.workspace, params);
    if (dir instanceof Response) return dir;
    const [comments, oids] = await Promise.all([
      readComments(deps.workspace, params.project, params.design),
      readDesignFiles(dir).then(designOids),
    ]);
    return Response.json(comments.map((c): CommentView => ({ ...c, detached: !oids.has(c.oid) })));
  });
}

/** POST …/comments { oid, text }. */
export function postComment(deps: CommentDeps, req: Request, params: Params): Promise<Response> {
  return run(async () => {
    const dir = await design(deps.workspace, params);
    if (dir instanceof Response) return dir;
    const b = await body(req);
    if (b instanceof Response) return b;
    if (typeof b.oid !== "string" || !OID.test(b.oid)) return fail("oid must be a data-oid.");
    const t = text(b.text);
    if (t instanceof Response) return t;
    const oids = await designOids(await readDesignFiles(dir));
    if (!oids.has(b.oid)) return fail(`No element has data-oid "${b.oid}" in this design.`);
    const comment = await addComment(deps.workspace, params.project, params.design, {
      oid: b.oid,
      text: t,
      version: await deps.version(params.project, params.design),
    });
    return Response.json({ ...comment, detached: false } satisfies CommentView, { status: 201 });
  });
}

/** PATCH …/comments/:id { text?, status? }. */
export function patchComment(deps: CommentDeps, req: Request, params: Params & { id: string }): Promise<Response> {
  return run(async () => {
    const dir = await design(deps.workspace, params);
    if (dir instanceof Response) return dir;
    const b = await body(req);
    if (b instanceof Response) return b;
    const patch: { text?: string; status?: Comment["status"] } = {};
    if (b.text !== undefined) {
      const t = text(b.text);
      if (t instanceof Response) return t;
      patch.text = t;
    }
    if (b.status !== undefined) {
      if (b.status !== "open" && b.status !== "done") return fail('status must be "open" or "done".');
      patch.status = b.status;
    }
    if (patch.text === undefined && patch.status === undefined) return fail("Send text or status.");
    const comment = await updateComment(deps.workspace, params.project, params.design, params.id, patch);
    const oids = await designOids(await readDesignFiles(dir));
    return Response.json({ ...comment, detached: !oids.has(comment.oid) } satisfies CommentView);
  });
}

/** DELETE …/comments/:id. */
export function deleteCommentRoute(deps: CommentDeps, params: Params & { id: string }): Promise<Response> {
  return run(async () => {
    const dir = await design(deps.workspace, params);
    if (dir instanceof Response) return dir;
    await deleteComment(deps.workspace, params.project, params.design, params.id);
    return new Response(null, { status: 204 });
  });
}
