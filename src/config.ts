import { resolve } from "node:path";

export type ProviderId = "anthropic" | "openai" | "google" | "openrouter" | "ollama";
export type HarnessId = "claude-code" | "codex" | "opencode" | "gemini-cli" | "aider";
export type ModelTask = "generate" | "edit" | "extract";

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

export interface ProviderConfig {
  api_key_env?: string;
  base_url?: string;
}

export interface Config {
  workspace: string;
  port: number;
  providers: Partial<Record<ProviderId, ProviderConfig>>;
  models: Record<ModelTask, ModelRef>;
  harness: { default: HarnessId };
}

const PROVIDERS: readonly ProviderId[] = ["anthropic", "openai", "google", "openrouter", "ollama"];
const HARNESSES: readonly HarnessId[] = ["claude-code", "codex", "opencode", "gemini-cli", "aider"];

/** Parses "anthropic:claude-opus-5-5". The model part may contain ":" (Ollama tags). */
export function parseModelRef(ref: string): ModelRef {
  const sep = ref.indexOf(":");
  if (sep <= 0 || sep === ref.length - 1) {
    throw new Error(`Invalid model ref "${ref}". Use "<provider>:<model>".`);
  }
  const provider = ref.slice(0, sep);
  if (!PROVIDERS.includes(provider as ProviderId)) {
    throw new Error(`Unknown provider "${provider}" in "${ref}".`);
  }
  return { provider: provider as ProviderId, model: ref.slice(sep + 1) };
}

const DEFAULTS = {
  workspace: "./workspace",
  port: 4317,
  models: {
    generate: "anthropic:claude-opus-5-5",
    edit: "anthropic:claude-sonnet-5-5",
    extract: "anthropic:claude-haiku-5-5",
  },
  harness: "claude-code",
} as const;

export function parseConfig(raw: Record<string, any>, baseDir = process.cwd()): Config {
  const models = { ...DEFAULTS.models, ...(raw.models ?? {}) } as Record<ModelTask, string>;
  const harness = (raw.harness?.default ?? DEFAULTS.harness) as HarnessId;
  if (!HARNESSES.includes(harness)) {
    throw new Error(`Unknown harness "${harness}".`);
  }
  return {
    workspace: resolve(baseDir, raw.workspace ?? DEFAULTS.workspace),
    port: Number(raw.port ?? DEFAULTS.port),
    providers: raw.providers ?? {},
    models: {
      generate: parseModelRef(models.generate),
      edit: parseModelRef(models.edit),
      extract: parseModelRef(models.extract),
    },
    harness: { default: harness },
  };
}

/** Loads config.toml from the current directory. A missing file gives the defaults. */
export async function loadConfig(path = "config.toml"): Promise<Config> {
  const file = Bun.file(path);
  const raw = (await file.exists()) ? Bun.TOML.parse(await file.text()) : {};
  return parseConfig(raw as Record<string, any>);
}
