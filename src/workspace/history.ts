import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { designFileAt, designFilesAt } from "./git.ts";
import { designDir, designFile } from "./paths.ts";

/**
 * Puts the page files of a design back as they were at `sha`. Files made later go away;
 * hidden files (comments) stay. The caller commits the result, so a restore is a new version.
 */
export async function restoreDesign(workspace: string, project: string, design: string, sha: string): Promise<boolean> {
  const files = await designFilesAt(workspace, project, design, sha);
  if (!files.length) return false;
  const contents = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const f of files) {
    const data = await designFileAt(workspace, project, design, sha, f);
    if (data) contents.set(f, data);
  }
  // Read everything first: a failed read must not leave half a design.
  const dir = designDir(workspace, project, design);
  for (const e of await readdir(dir)) {
    if (!e.startsWith(".")) await rm(join(dir, e), { recursive: true, force: true });
  }
  for (const [f, data] of contents) {
    const path = designFile(workspace, project, design, f);
    if (!path) continue;
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, data);
  }
  return true;
}
