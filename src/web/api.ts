// The server owns the API types; type-only imports add nothing to the UI bundle.
export type { ProjectSummary } from "../workspace/paths.ts";
export type { ProviderStatus } from "../providers/status.ts";
export type { ChatEntry, Usage } from "../workspace/chat.ts";
export type { TurnStreamEvent } from "../server/turns.ts";

export interface AppConfig {
  models: Record<"generate" | "edit" | "extract", { provider: string; model: string }>;
  harness: { default: string };
  workspace: string;
}

export type Harnesses = Record<string, boolean>;

/** Result of an async load, so each view can show its loading, error and ready states. */
export type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: T };

export async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export function designUrl(project: string, design: string): string {
  return `/design/${project}/${design}/`;
}

/** Generation endpoint for one design (#7). */
export function turnUrl(project: string, design: string): string {
  return `/api/projects/${project}/designs/${design}/turns`;
}

/** Stored chat of one design (#8). */
export function chatUrl(project: string, design: string): string {
  return `/api/projects/${project}/designs/${design}/chat`;
}

/** Sends JSON. Returns the parsed answer, or throws with the server's error message. */
export async function sendJSON<T>(method: "POST" | "PATCH", url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}
