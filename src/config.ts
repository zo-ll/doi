import { dirname, resolve } from "node:path";

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
  /** USD per 1M tokens for "<provider>:<model>", for the usage report. Missing means no cost. */
  prices: Record<string, Price>;
  /** config.toml, where the UI writes the model choice; null when doi runs without a file path. */
  configPath: string | null;
}

export interface Price {
  input: number;
  output: number;
  /** Cached input tokens; the input price when not set. */
  cached?: number;
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

/** A model name that goes to a CLI as an argument: it must not look like a flag. */
export const MODEL_NAME = /^[A-Za-z0-9._@/][A-Za-z0-9._:@/-]{0,99}$/;

/** A model the user chose in the UI ("<provider>:<model>"), or the reason it is not valid. */
export function parseModelChoice(raw: unknown): ModelRef | string {
  if (typeof raw !== "string") return 'A model must be "<provider>:<model>".';
  try {
    const ref = parseModelRef(raw.trim());
    if (!MODEL_NAME.test(ref.model)) return `The model name "${ref.model}" is not valid.`;
    return ref;
  } catch (e) {
    return (e as Error).message;
  }
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
    prices: parsePrices(raw.prices),
    configPath: null,
  };
}

/** The [prices] table. An entry with a bad number is left out, not an error. */
function parsePrices(raw: unknown): Record<string, Price> {
  const out: Record<string, Price> = {};
  if (typeof raw !== "object" || raw === null) return out;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  for (const [ref, p] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    const input = num(p?.input);
    const output = num(p?.output);
    const cached = num(p?.cached);
    if (input === undefined || output === undefined) continue;
    out[ref] = { input, output, ...(cached !== undefined ? { cached } : {}) };
  }
  return out;
}

/**
 * Writes the model of each task into the [models] table of a config.toml text. Only those
 * lines change: comments and other tables stay as they are. A missing table is added.
 */
export function withModels(text: string, models: Record<ModelTask, ModelRef>): string {
  const value = (t: ModelTask) => `${t} = "${models[t].provider}:${models[t].model}"`;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s*\[models\]\s*(#.*)?$/.test(l));
  if (start < 0) {
    const body = text.replace(/\s*$/, "");
    return `${body}${body ? "\n\n" : ""}[models]\n${(["generate", "edit", "extract"] as const).map(value).join("\n")}\n`;
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const done = new Set<ModelTask>();
  for (let i = start + 1; i < end; i++) {
    const m = /^\s*(generate|edit|extract)\s*=/.exec(lines[i]!);
    if (!m) continue;
    const task = m[1] as ModelTask;
    // A trailing comment stays, with the spaces before it. A "#" inside the quoted value does not count.
    const line = lines[i]!;
    const hash = line.replace(/"[^"]*"/g, (q) => "x".repeat(q.length)).indexOf("#");
    let from = hash;
    while (from > 0 && /\s/.test(line[from - 1]!)) from--;
    lines[i] = value(task) + (hash > 0 ? line.slice(from) : "");
    done.add(task);
  }
  const missing = (["generate", "edit", "extract"] as const).filter((t) => !done.has(t)).map(value);
  lines.splice(start + 1, 0, ...missing);
  return lines.join("\n");
}

/**
 * Replaces the [prices] table of a config.toml text (and any [prices.…] tables) with these
 * prices. Other lines stay as they are. No prices: the table goes.
 */
export function withPrices(text: string, prices: Record<string, Price>): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let inPrices = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) inPrices = header[1]!.trim() === "prices" || header[1]!.trim().startsWith("prices.");
    if (!inPrices) kept.push(line);
  }
  const body = kept.join("\n").replace(/\s*$/, "");
  const entries = Object.entries(prices);
  if (!entries.length) return `${body}\n`;
  const row = ([ref, p]: [string, Price]) =>
    `${JSON.stringify(ref)} = { input = ${p.input}, output = ${p.output}${p.cached !== undefined ? `, cached = ${p.cached}` : ""} }`;
  return `${body}${body ? "\n\n" : ""}[prices]\n${entries.map(row).join("\n")}\n`;
}

/**
 * Loads config.toml (default: from the current directory). A missing file gives the defaults.
 * A relative workspace path is relative to the folder of the file.
 */
export async function loadConfig(path = "config.toml"): Promise<Config> {
  const file = Bun.file(path);
  const raw = (await file.exists()) ? Bun.TOML.parse(await file.text()) : {};
  return { ...parseConfig(raw as Record<string, any>, dirname(resolve(path))), configPath: resolve(path) };
}
