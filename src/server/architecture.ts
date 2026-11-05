import { z } from "zod";
import { architectureViewSchema } from "../architecture/schema.ts";
import { ArchitectureError, MAX_ARCHITECTURE_BYTES, readArchitecture, writeArchitecture } from "../workspace/architecture.ts";
import { architectureAt, architectureVersions, checkpointArchitecture, checkpointSchema } from "../workspace/architecture-history.ts";

/** Bound the stream before JSON parsing, including requests without Content-Length. */
export async function readBody(req: Request): Promise<unknown> {
  if (!req.body) throw new ArchitectureError(400, "The body must be JSON.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ARCHITECTURE_BYTES) throw new ArchitectureError(413, "The UML request exceeds 4 MB.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return data;
  } catch (cause) {
    throw new ArchitectureError(400, "The body must be valid JSON.", { cause });
  }
}
export function failure(error: unknown): Response {
  if (error instanceof ArchitectureError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof z.ZodError) return Response.json({ error: error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  console.error("UML request failed:", error);
  return Response.json({ error: "Could not read or save the UML data." }, { status: 500 });
}
export async function getArchitecture(workspace: string, project: string): Promise<Response> {
  try { return Response.json(await readArchitecture(workspace, project)); }
  catch (error) { return failure(error); }
}
export async function putArchitecture(workspace: string, project: string, req: Request): Promise<Response> {
  try {
    const body = architectureViewSchema.parse(await readBody(req));
    return Response.json(await writeArchitecture(workspace, project, body.revision, body.state));
  } catch (error) { return failure(error); }
}
export async function getArchitectureVersions(workspace: string, project: string): Promise<Response> {
  try { return Response.json({ versions: await architectureVersions(workspace, project) }); }
  catch (error) { return failure(error); }
}
export async function getArchitectureVersion(workspace: string, project: string, sha: string): Promise<Response> {
  try { return Response.json({ state: await architectureAt(workspace, project, sha) }); }
  catch (error) { return failure(error); }
}
export async function postArchitectureCheckpoint(workspace: string, project: string, req: Request): Promise<Response> {
  try {
    const { label } = checkpointSchema.parse(await readBody(req));
    return Response.json(await checkpointArchitecture(workspace, project, label));
  } catch (error) { return failure(error); }
}
