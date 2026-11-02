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
  /** The model can read images; null when doi cannot tell. */
  vision: boolean | null;
}

/** The names the UI shows for provider ids. */
export const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  anthropic: "Anthropic API",
  openai: "OpenAI API",
  "opencode-go": "OpenCode Go",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  ollama: "Ollama",
};
export const providerName = (id: string) => PROVIDER_NAMES[id] ?? id;

export const TASKS: { id: Task; label: string; hint: string }[] = [
  { id: "generate", label: "Generate", hint: "Full designs" },
  { id: "edit", label: "Edit", hint: "Small targeted edits" },
  { id: "extract", label: "Extract", hint: "Design systems" },
];

const SOURCE: Record<ProviderStatus["source"], string> = { cli: "CLI · subscription", api_key: "API key", local: "local server" };

/** A short name for a model id: "claude-opus-5-5" → "Opus 5.5". Other ids stay as they are. */
export function shortModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}` : id;
}

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
export function taskStatuses(models: AppConfig["models"], providers: ProviderStatus[] | null, vision: AppConfig["vision"] = {}): TaskStatus[] {
  return TASKS.map(({ id }) => {
    const ref = models[id];
    const s = providers ? statusOf(providers.find((p) => p.id === ref.provider)) : { tone: "unknown" as const, label: "Checking…", via: "" };
    return { task: id, provider: ref.provider, model: ref.model, ...s, vision: vision[id] ?? null };
  });
}

/** How the user connects a vendor: OAuth through the official CLI, an API key, or a local server. */
export type AuthMethod = "oauth" | "api_key" | "local";

export interface Vendor {
  id: string;
  name: string;
  /** The provider id behind each method. */
  methods: Partial<Record<AuthMethod, string>>;
  /** OAuth only: what the login uses. */
  oauthLabel?: string;
}

/** The providers that Settings lists, each with its ways to connect. */
export const VENDORS: Vendor[] = [
  { id: "anthropic", name: "Anthropic", methods: { oauth: "claude-code", api_key: "anthropic" }, oauthLabel: "Claude subscription · Claude Code CLI" },
  { id: "openai", name: "OpenAI", methods: { oauth: "codex", api_key: "openai" }, oauthLabel: "ChatGPT plan · Codex CLI" },
  { id: "opencode-go", name: "OpenCode Go", methods: { api_key: "opencode-go" } },
  { id: "google", name: "Google Gemini", methods: { api_key: "google" } },
  { id: "openrouter", name: "OpenRouter", methods: { api_key: "openrouter" } },
  { id: "ollama", name: "Ollama", methods: { local: "ollama" } },
];

export const METHOD_LABEL: Record<AuthMethod, string> = { oauth: "OAuth", api_key: "API key", local: "Local server" };

/** The methods of a vendor in display order. */
export function methodsOf(v: Vendor): AuthMethod[] {
  return (["oauth", "api_key", "local"] as const).filter((m) => v.methods[m]);
}

/** The method to show first: one that is ready, else the first one. */
export function defaultMethod(v: Vendor, providers: ProviderStatus[]): AuthMethod {
  const all = methodsOf(v);
  return all.find((m) => providers.some((p) => p.id === v.methods[m] && p.ready)) ?? all[0]!;
}

/** The vendor to show first: the one of the generate model. */
export function vendorOf(providerId: string): Vendor {
  return VENDORS.find((v) => Object.values(v.methods).includes(providerId)) ?? VENDORS[0]!;
}
