// Provider status for the UI without React: a dot colour and a short label per task.
import type { AppConfig, ProviderStatus } from "./api.ts";

export type Task = keyof AppConfig["models"];
export type Tone = "ok" | "warn" | "err" | "unknown";

export interface TaskStatus {
  task: Task;
  provider: string;
  model: string;
  tone: Tone;
  /** "Logged in", "Missing API key", "CLI not found"… */
  label: string;
  /** How the provider connects, or what to do to make it ready. */
  via: string;
}

export const TASKS: { id: Task; label: string; hint: string }[] = [
  { id: "generate", label: "Generate", hint: "Full designs" },
  { id: "edit", label: "Edit", hint: "Small targeted edits" },
  { id: "extract", label: "Extract", hint: "Design systems" },
];

const SOURCE: Record<ProviderStatus["source"], string> = { cli: "CLI · subscription", api_key: "API key", local: "local server" };

/** One status: green when ready, red when the CLI or server is missing, amber for the rest. */
export function statusOf(p: ProviderStatus | undefined): { tone: Tone; label: string; via: string } {
  if (!p) return { tone: "unknown", label: "Unknown", via: "" };
  // The detail adds only what the label does not say already.
  const withDetail = (label: string) => (p.detail === label ? SOURCE[p.source] : `${SOURCE[p.source]} · ${p.detail}`);
  const via = withDetail(p.ready && p.source === "cli" ? "Logged in" : "");
  if (!p.implemented) return { tone: "err", label: "Not available", via: "doi has no adapter for this provider yet." };
  if (p.ready) return { tone: "ok", label: p.source === "cli" ? "Logged in" : "Ready", via };
  if (/not found/i.test(p.detail)) return { tone: "err", label: p.source === "cli" ? "CLI not found" : "Not found", via };
  if (p.source === "api_key") return { tone: "warn", label: "Missing API key", via };
  if (p.source === "local") return { tone: "err", label: "Not running", via };
  return { tone: "warn", label: "Not logged in", via };
}

/** The model and status of each task, in task order. */
export function taskStatuses(models: AppConfig["models"], providers: ProviderStatus[] | null): TaskStatus[] {
  return TASKS.map(({ id }) => {
    const ref = models[id];
    const s = providers ? statusOf(providers.find((p) => p.id === ref.provider)) : { tone: "unknown" as const, label: "Checking…", via: "" };
    return { task: id, provider: ref.provider, model: ref.model, ...s };
  });
}
