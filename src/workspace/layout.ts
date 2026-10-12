import { rename, writeFile } from "node:fs/promises";
import { withFileLock } from "./file-lock.ts";
import { assertName } from "./paths.ts";
import { defaultLayout, parseLayout, type Frame } from "./frames.ts";
import { projectFile } from "./project-file.ts";

export * from "./frames.ts";

/** Reads project.json. A missing file or bad JSON gives an empty object. */
async function readMeta(workspace: string, project: string): Promise<Record<string, unknown>> {
  const file = Bun.file(projectFile(workspace, project));
  if (!(await file.exists())) return {};
  try {
    const data = await file.json();
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Changes project.json, one change at a time for each project, and replaces the file whole.
 * Every writer of project.json goes through here, so a rename and a layout change cannot
 * overwrite each other.
 */
export function updateProjectMeta(
  workspace: string,
  project: string,
  change: (meta: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  assertName("project", project);
  const path = projectFile(workspace, project);
  return withFileLock(path, async () => {
    const next = change(await readMeta(workspace, project));
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    // No mkdir: a project that is gone must not come back as a folder with only project.json.
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n");
    await rename(tmp, path);
  });
}

function layoutsOf(meta: Record<string, unknown>): Record<string, unknown> {
  const l = meta.layouts;
  // No prototype: a design name is safe, but keys in a hand-edited file may not be.
  return Object.assign(Object.create(null), typeof l === "object" && l !== null && !Array.isArray(l) ? l : {});
}

/** The frames of a design: the stored ones, or the default layout. */
export async function readLayout(workspace: string, project: string, design: string): Promise<Frame[]> {
  assertName("design", design);
  const stored = layoutsOf(await readMeta(workspace, project))[design];
  const parsed = stored === undefined ? null : parseLayout(stored);
  return parsed && typeof parsed !== "string" ? parsed : defaultLayout();
}

export function writeLayout(workspace: string, project: string, design: string, frames: Frame[]): Promise<void> {
  assertName("design", design);
  return updateProjectMeta(workspace, project, (meta) => ({ ...meta, layouts: { ...layoutsOf(meta), [design]: frames } }));
}

/** Moves the layout of a renamed design. Nothing happens when it has none. */
export function renameLayout(workspace: string, project: string, from: string, to: string): Promise<void> {
  return updateProjectMeta(workspace, project, (meta) => {
    const layouts = layoutsOf(meta);
    if (!(from in layouts)) return meta;
    layouts[to] = layouts[from];
    delete layouts[from];
    return { ...meta, layouts: { ...layouts } };
  });
}
