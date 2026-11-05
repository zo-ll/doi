import { lstat, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { architectureSchema, emptyArchitecture, type ArchitectureView } from "../architecture/schema.ts";
import { withFileLock } from "./file-lock.ts";
import { assertName } from "./paths.ts";

export const MAX_ARCHITECTURE_BYTES = 4 * 1024 * 1024;
export class ArchitectureError extends Error {
  constructor(readonly status: number, message: string, options?: ErrorOptions) { super(message, options); }
}
const missing = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";

export async function architecturePath(workspace: string, project: string): Promise<string> {
  try { assertName("project", project); }
  catch (cause) { throw new ArchitectureError(400, cause instanceof Error ? cause.message : "Invalid project.", { cause }); }
  const root = await realpath(workspace);
  const dir = join(root, "projects", project);
  try {
    if (await realpath(dir) !== dir || !(await lstat(dir)).isDirectory()) throw new ArchitectureError(400, "The project must be a workspace folder, not a link.");
  } catch (error) {
    if (missing(error)) throw new ArchitectureError(404, "Project not found.");
    throw error;
  }
  return join(dir, "architecture.json");
}
const revisionOf = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

export async function readArchitecture(workspace: string, project: string): Promise<ArchitectureView> {
  const path = await architecturePath(workspace, project);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ArchitectureError(400, "The UML file must be a regular file.");
    if (stat.size > MAX_ARCHITECTURE_BYTES) throw new ArchitectureError(413, "The UML file exceeds 4 MB.");
    const text = await Bun.file(path).text();
    if (Buffer.byteLength(text) > MAX_ARCHITECTURE_BYTES) throw new ArchitectureError(413, "The UML file exceeds 4 MB.");
    try {
      const raw: unknown = JSON.parse(text);
      return { revision: revisionOf(text), state: architectureSchema.parse(raw) };
    } catch (cause) {
      throw new ArchitectureError(422, "The saved UML data is invalid. Recover it before you save.", { cause });
    }
  } catch (error) {
    if (missing(error)) return { revision: null, state: emptyArchitecture() };
    throw error;
  }
}

/** A stale client never replaces another change. A disabled state retains its diagrams. */
export async function writeArchitecture(workspace: string, project: string, expected: string | null, input: unknown): Promise<ArchitectureView> {
  const state = architectureSchema.parse(input);
  const text = JSON.stringify(state, null, 2) + "\n";
  if (Buffer.byteLength(text) > MAX_ARCHITECTURE_BYTES) throw new ArchitectureError(413, "The UML data exceeds 4 MB.");
  const path = await architecturePath(workspace, project);
  return withFileLock(path, async () => {
    const current = await readArchitecture(workspace, project);
    if (current.revision !== expected) throw new ArchitectureError(409, "The diagram changed elsewhere. Your edits are not saved. Load the latest version or save a copy.");
    const revision = revisionOf(text);
    if (revision === current.revision) return current;
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
      await rename(tmp, path);
    } finally {
      await rm(tmp, { force: true });
    }
    return { revision, state };
  });
}
