export interface ProjectSummary {
  id: string;
  name: string;
  designs: string[];
}

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
