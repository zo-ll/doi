import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "./file-lock.ts";
import { designDir } from "./paths.ts";

/** A comment on one element of a design, by its data-oid. */
export interface Comment {
  id: string;
  oid: string;
  text: string;
  status: "open" | "done";
  /** The last commit of the design when the comment was made, or null before the first one. */
  version: string | null;
  createdAt: string;
  /** When the comment was marked done. */
  doneAt?: string;
}

/** Comments are stored per design. The dot keeps the file out of the model's context and the live reload. */
export const COMMENTS_FILE = ".comments.json";
export const MAX_COMMENT = 5000;

export class CommentError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function commentsFile(workspace: string, project: string, design: string): string {
  return join(designDir(workspace, project, design), COMMENTS_FILE);
}

/** The comments of a design, oldest first. A file that is not valid JSON is an error, so a write cannot erase it. */
export async function readComments(workspace: string, project: string, design: string): Promise<Comment[]> {
  const file = Bun.file(commentsFile(workspace, project, design));
  if (!(await file.exists())) return [];
  let data: unknown;
  try {
    data = await file.json();
  } catch {
    throw new CommentError(`${COMMENTS_FILE} of ${project}/${design} is not valid JSON. Correct or remove the file.`, 500);
  }
  if (!Array.isArray(data)) throw new CommentError(`${COMMENTS_FILE} of ${project}/${design} must hold a list.`, 500);
  return data as Comment[];
}

/**
 * Reads, changes and replaces the comments file, one change at a time. The write does not
 * create folders: when the design was renamed or removed meanwhile, it fails with 404.
 */
function change<T>(
  workspace: string,
  project: string,
  design: string,
  job: (comments: Comment[]) => { comments: Comment[]; result: T },
): Promise<T> {
  const path = commentsFile(workspace, project, design);
  return withFileLock(path, async () => {
    if (!(await Bun.file(join(designDir(workspace, project, design), "index.html")).exists())) {
      throw new CommentError("Design not found.", 404);
    }
    const { comments, result } = job(await readComments(workspace, project, design));
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(comments, null, 2) + "\n");
      await rename(tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new CommentError("Design not found.", 404);
      throw e;
    }
    return result;
  });
}

export function addComment(
  workspace: string,
  project: string,
  design: string,
  input: { oid: string; text: string; version: string | null },
): Promise<Comment> {
  const comment: Comment = {
    id: crypto.randomUUID(),
    oid: input.oid,
    text: input.text,
    status: "open",
    version: input.version,
    createdAt: new Date().toISOString(),
  };
  return change(workspace, project, design, (comments) => ({ comments: [...comments, comment], result: comment }));
}

export function updateComment(
  workspace: string,
  project: string,
  design: string,
  id: string,
  patch: { text?: string; status?: Comment["status"] },
): Promise<Comment> {
  return change(workspace, project, design, (comments) => {
    const old = comments.find((c) => c.id === id);
    if (!old) throw new CommentError("Comment not found.", 404);
    const next: Comment = { ...old, ...(patch.text !== undefined ? { text: patch.text } : {}) };
    if (patch.status === "done" && old.status !== "done") Object.assign(next, { status: "done", doneAt: new Date().toISOString() });
    if (patch.status === "open") {
      next.status = "open";
      delete next.doneAt;
    }
    return { comments: comments.map((c) => (c.id === id ? next : c)), result: next };
  });
}

export function deleteComment(workspace: string, project: string, design: string, id: string): Promise<void> {
  return change(workspace, project, design, (comments) => {
    if (!comments.some((c) => c.id === id)) throw new CommentError("Comment not found.", 404);
    return { comments: comments.filter((c) => c.id !== id), result: undefined };
  });
}
