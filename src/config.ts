import { resolve } from "node:path";

/** API providers, and CLI backends that use a subscription through the official CLI. */
export type ProviderId = "anthropic" | "openai" | "opencode-go" | "google" | "openrouter" | "ollama" | "claude-code" | "codex";
export type ModelTask = "generate" | "edit" | "extract";

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

export interface ProviderConfig {
  api_key_env?: string;
  base_url?: string;
  /** OpenCode Go only: model id → wire format ("chat", "messages" or "responses"). */
  formats?: Record<string, string>;
}

export interface Config {
  workspace: string;
  port: number;
  providers: Partial<Record<ProviderId, ProviderConfig>>;
  models: Record<ModelTask, ModelRef>;
  /** Link that opens a file in the user's editor; {path} is the absolute path. */
  editorUrl: string;
}

export const PROVIDERS: readonly ProviderId[] = [
  "anthropic",
  "openai",
  "opencode-go",
  "google",
  "openrouter",
  "ollama",
  "claude-code",
  "codex",
];
/** Default API key variables. config.toml can name another one per provider (api_key_env). */
export const DEFAULT_KEY_ENV: Partial<Record<ProviderId, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export function keyEnvFor(id: ProviderId, config: Pick<Config, "providers">): string | undefined {
  return config.providers[id]?.api_key_env ?? DEFAULT_KEY_ENV[id];
}

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
    generate: "claude-code:claude-opus-5-5",
    edit: "claude-code:claude-sonnet-5-5",
    extract: "claude-code:claude-haiku-5-5",
  },
  editorUrl: "vscode://file{path}",
} as const;

export function parseConfig(raw: Record<string, any>, baseDir = process.cwd()): Config {
  const models = { ...DEFAULTS.models, ...(raw.models ?? {}) } as Record<ModelTask, string>;
  return {
    workspace: resolve(baseDir, raw.workspace ?? DEFAULTS.workspace),
    port: Number(raw.port ?? DEFAULTS.port),
    providers: raw.providers ?? {},
    models: {
      generate: parseModelRef(models.generate),
      edit: parseModelRef(models.edit),
      extract: parseModelRef(models.extract),
    },
    editorUrl: String(raw.editor_url ?? DEFAULTS.editorUrl),
  };
}

/** Loads config.toml from the current directory. A missing file gives the defaults. */
export async function loadConfig(path = "config.toml"): Promise<Config> {
  const file = Bun.file(path);
  const raw = (await file.exists()) ? Bun.TOML.parse(await file.text()) : {};
  return parseConfig(raw as Record<string, any>);
}
