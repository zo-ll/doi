import { realpath } from "node:fs/promises";
import { z } from "zod";
import { architectureSchema, type Architecture } from "../architecture/schema.ts";
import { ArchitectureError, architecturePath } from "./architecture.ts";
import { withFileLock } from "./file-lock.ts";
import { commitPaths, fileAt, fileLog, isSha, type Version } from "./git.ts";

/**
 * Persistent UML versions are git commits of `architecture.json`, like the versions of a design.
 * Autosave writes the file; a checkpoint commits it. Without git, the list is empty and a
 * checkpoint records nothing.
 */
export const checkpointSchema = z.strictObject({ label: z.string().trim().min(1).max(200) });

/** The paths that git sees: the workspace can be a link, `architecturePath` is resolved. */
async function located(workspace: string, project: string): Promise<{ root: string; path: string }> {
  const path = await architecturePath(workspace, project);
  return { root: await realpath(workspace), path };
}

export async function architectureVersions(workspace: string, project: string): Promise<Version[]> {
  const { root, path } = await located(workspace, project);
  return fileLog(root, path);
}

export async function architectureAt(workspace: string, project: string, sha: string): Promise<Architecture> {
  if (!isSha(sha)) throw new ArchitectureError(400, "Invalid version id.");
  const { root, path } = await located(workspace, project);
  const text = await fileAt(root, path, sha);
  if (text === null) throw new ArchitectureError(404, "This UML version is not in the history.");
  try { return architectureSchema.parse(JSON.parse(text)); }
  catch (cause) { throw new ArchitectureError(422, "This UML version is invalid and cannot be restored.", { cause }); }
}

/** Commits the saved file under the write lock. Returns the commit id, or null when nothing changed. */
export async function checkpointArchitecture(workspace: string, project: string, label: string): Promise<string | null> {
  const { root, path } = await located(workspace, project);
  return withFileLock(path, async () => {
    if (!(await Bun.file(path).exists())) return null;
    try { return await commitPaths(root, [path], `UML: ${label}`); }
    catch (error) {
      console.error("UML version not recorded:", error instanceof Error ? error.message : error);
      return null;
    }
  });
}
