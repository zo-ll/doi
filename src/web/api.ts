// The server owns the API types; type-only imports add nothing to the UI bundle.
export type { ProjectSummary } from "../workspace/paths.ts";
export type { ProviderStatus } from "../providers/status.ts";
export type { ChatEntry, Usage } from "../workspace/chat.ts";
export type { TurnStreamEvent } from "../server/turns.ts";
export type { CommentView } from "../server/comments.ts";
export type { VariantSetView, VariantStreamEvent } from "../server/variants.ts";
export type { VersionView } from "../server/history.ts";

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
export async function sendJSON<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

/** An image the user attached to a message (#9). */
export function uploadUrl(project: string, name: string): string {
  return `/api/projects/${project}/uploads/${name}`;
}

/** Comments of one design (#16); with an id, one comment. */
export function commentsUrl(project: string, design: string, id?: string): string {
  return `/api/projects/${project}/designs/${design}/comments${id ? `/${id}` : ""}`;
}

/** Variants of one design (#19): the open set, a pick, a discard. */
export function variantsUrl(project: string, design: string, path = ""): string {
  return `/api/projects/${project}/designs/${design}/variants${path}`;
}

/** A file of one variant, for its frame. */
export function variantPageUrl(project: string, design: string, set: string, n: number): string {
  return `/variant/${project}/${design}/${set}/${n}/`;
}

/** Versions of one design (#20); with a commit id, its restore action. */
export function historyUrl(project: string, design: string, path = ""): string {
  return `/api/projects/${project}/designs/${design}/history${path}`;
}

/** A design as it was at a commit, for the preview frame. */
export function versionPageUrl(project: string, design: string, sha: string): string {
  return `/version/${project}/${design}/${sha}/`;
}
