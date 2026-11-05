import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { architectureSchema, architectureViewSchema, type Architecture, type ArchitectureView } from "../architecture/schema.ts";
import type { Load } from "./api.ts";

/** A failed UML request keeps its HTTP status: 409 means another write came first. */
export class ArchitectureRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
async function request(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  const data: unknown = await response.json();
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string" ? data.error : `UML request failed (${response.status}).`;
    throw new ArchitectureRequestError(response.status, message);
  }
  return data;
}
export async function architectureRequest(project: string, body?: ArchitectureView, signal?: AbortSignal): Promise<ArchitectureView> {
  return architectureViewSchema.parse(await request(`/api/projects/${project}/architecture`, {
    method: body ? "PUT" : "GET", signal,
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  }));
}

const versionsSchema = z.object({ versions: z.array(z.object({ sha: z.string(), at: z.string(), message: z.string() })) });
export type ArchitectureVersion = z.infer<typeof versionsSchema>["versions"][number];
export async function architectureVersions(project: string, signal?: AbortSignal): Promise<ArchitectureVersion[]> {
  return versionsSchema.parse(await request(`/api/projects/${project}/architecture/versions`, { signal })).versions;
}
export async function architectureVersion(project: string, sha: string, signal?: AbortSignal): Promise<Architecture> {
  return z.object({ state: architectureSchema }).parse(await request(`/api/projects/${project}/architecture/versions/${encodeURIComponent(sha)}`, { signal })).state;
}
/** Records the saved file as a version. `keepalive` lets the request finish when the editor closes. */
export async function architectureCheckpoint(project: string, label: string): Promise<string | null> {
  const data = await request(`/api/projects/${project}/architecture/checkpoint`, {
    method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ label: label.slice(0, 200) }),
  });
  return z.object({ sha: z.string().nullable() }).parse(data).sha;
}

type WriteStatus = { state: "idle" } | { state: "saving" } | { state: "error"; message: string };
export function useArchitecture(project: string | null) {
  const [attempt, setAttempt] = useState(0);
  const token = useMemo(() => ({ project }), [project, attempt]);
  const live = useRef(token); live.current = token;
  const controllers = useRef(new Set<AbortController>());
  const [load, setLoad] = useState<{ token: typeof token; data: Load<ArchitectureView> }>({ token, data: { state: "loading" } });
  const [save, setSave] = useState<{ token: typeof token } & WriteStatus>({ token, state: "idle" });
  useEffect(() => {
    setLoad({ token, data: { state: "loading" } });
    setSave({ token, state: "idle" });
    if (!project) return;
    const controller = new AbortController();
    architectureRequest(project, undefined, controller.signal).then(
      data => { if (live.current === token) setLoad({ token, data: { state: "ready", data } }); },
      error => { if (!controller.signal.aborted && live.current === token) setLoad({ token, data: { state: "error", message: error instanceof Error ? error.message : String(error) } }); },
    );
    return () => { controller.abort(); for (const request of controllers.current) request.abort(); controllers.current.clear(); };
  }, [project, token, attempt]);
  const data: Load<ArchitectureView> = load.token === token ? load.data : { state: "loading" };
  const write = useCallback(async (state: Architecture): Promise<ArchitectureView> => {
    if (!project || load.token !== token || load.data.state !== "ready") throw new Error("Load the project before you save UML.");
    if (controllers.current.size) throw new Error("A UML save is already active.");
    const controller = new AbortController(); controllers.current.add(controller);
    setSave({ token, state: "saving" });
    try {
      const next = await architectureRequest(project, { revision: load.data.data.revision, state }, controller.signal);
      if (live.current !== token) throw new DOMException("The project changed.", "AbortError");
      setLoad({ token, data: { state: "ready", data: next } });
      setSave({ token, state: "idle" });
      return next;
    } catch (error) {
      if (live.current === token) setSave({ token, state: "error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { controllers.current.delete(controller); }
  }, [project, load, token]);
  return { load: data, write, busy: save.token === token && save.state === "saving", error: save.token === token && save.state === "error" ? save.message : undefined, reload: () => setAttempt(n => n + 1) };
}
