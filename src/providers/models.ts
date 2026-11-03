import { z } from "zod";
import { MODEL_NAME, type Config, type ProviderId } from "../config.ts";
import { keyStore, resolveKey, type KeyStore } from "./keys.ts";
import { DEFAULT_MODEL as DEFAULT_CODEX_MODEL } from "./codex.ts";
import { DOI_USER_AGENT, OPENCODE_GO_BASE_URL } from "./opencode-go.ts";

/**
 * The models a provider offers, for the model field in Settings. API providers answer from their
 * models endpoint with the key (on the server only; the UI gets ids). Codex lists its catalog with
 * `codex debug models`; Claude Code has no such command, so it gets a fixed list. Settings shows the
 * list and also takes a typed id.
 */
export type ModelList = { ok: true; models: string[]; fixed: boolean } | { ok: false; error: string };

export interface ModelListDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: Record<string, string | undefined>;
  keys: KeyStore;
  /** Runs a CLI and gives its stdout, or null when it fails. */
  run: (cmd: string[]) => Promise<string | null>;
}

export const defaultModelListDeps: ModelListDeps = {
  fetch: (url, init) => fetch(url, init),
  env: process.env,
  get keys() {
    return keyStore();
  },
  async run(cmd) {
    const [bin] = cmd;
    if (!bin || !Bun.which(bin)) return null;
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: TIMEOUT_MS });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out : null;
  },
};

/**
 * The Codex catalog: the ids it lists to users, after "default". Only the ids leave this
 * function. Without the catalog the list is "default" only.
 */
async function codexModels(deps: ModelListDeps): Promise<string[]> {
  const out = await deps.run(["codex", "debug", "models"]).catch(() => null);
  try {
    if (!out) return [DEFAULT_CODEX_MODEL];
    const { models } = z.object({ models: z.array(z.unknown()) }).parse(JSON.parse(out));
    const listed = models.flatMap((value) => {
      const model = entrySchema.safeParse(value);
      return model.success && model.data.visibility === "list" ? [model.data.slug] : [];
    });
    return [DEFAULT_CODEX_MODEL, ...clean(listed).filter((m) => m !== DEFAULT_CODEX_MODEL)];
  } catch {
    return [DEFAULT_CODEX_MODEL];
  }
}

/** Claude Code takes these ids with --model. */
const FIXED: Partial<Record<ProviderId, readonly string[]>> = {
  "claude-code": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
};

/** OpenAI lists every model; these are not chat models. */
const NOT_CHAT = /embed|tts|whisper|dall-e|moderation|transcribe|audio|realtime|image|search|davinci|babbage/i;

const TIMEOUT_MS = 10_000;
const MAX_PAGES = 5;

const trim = (url: string) => url.replace(/\/+$/, "");

/** Ids that the model field takes, sorted and without doubles. */
function clean(ids: readonly unknown[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && MODEL_NAME.test(id)))].sort();
}

const entrySchema = z.record(z.string(), z.unknown());
const modelsSchema = z.object({ data: z.array(z.unknown()) });
const tagsSchema = z.object({ models: z.array(z.unknown()) });
const pageSchema = modelsSchema.extend({ has_more: z.boolean().optional(), last_id: z.string().nullish() })
  .refine((page) => !page.has_more || Boolean(page.last_id));

function idsOf(entries: readonly unknown[], field: "id" | "name"): unknown[] {
  return entries.flatMap((value) => {
    const entry = entrySchema.safeParse(value);
    return entry.success ? [entry.data[field]] : [];
  });
}

async function getJSON(deps: ModelListDeps, url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await deps.fetch(url, { headers: { "user-agent": DOI_USER_AGENT, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 401 || res.status === 403) throw new Error(`The provider refused the API key (${res.status}).`);
  if (!res.ok) throw new Error(`The models endpoint answered ${res.status}.`);
  return res.json();
}

export async function listModels(id: ProviderId, config: Config, deps: ModelListDeps = defaultModelListDeps): Promise<ModelList> {
  const fixed = FIXED[id];
  if (fixed) return { ok: true, models: [...fixed], fixed: true };
  if (id === "codex") return { ok: true, models: await codexModels(deps), fixed: true };
  const base = config.providers[id]?.base_url;
  try {
    if (id === "ollama") {
      const data = tagsSchema.parse(await getJSON(deps, `${trim(base ?? "http://localhost:11434")}/api/tags`, {}));
      return { ok: true, models: clean(idsOf(data.models, "name")), fixed: false };
    }
    if (id !== "anthropic" && id !== "openai" && id !== "opencode-go") return { ok: false, error: "doi has no adapter for this provider yet." };

    const key = (await resolveKey(id, config, deps.env, deps.keys))?.value;
    // OpenCode Go lists its models without a key; the other two need one.
    if (!key && id !== "opencode-go") return { ok: false, error: "Add an API key to list the models." };

    if (id === "anthropic" && key) {
      const ids: unknown[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const q = new URLSearchParams({ limit: "1000", ...(after ? { after_id: after } : {}) });
        const data = pageSchema.parse(await getJSON(deps, `${trim(base ?? "https://api.anthropic.com/v1")}/models?${q}`, {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        }));
        ids.push(...idsOf(data.data, "id"));
        if (!data.has_more || !data.last_id) break;
        after = data.last_id;
      }
      return { ok: true, models: clean(ids), fixed: false };
    }

    const url = `${trim(base ?? (id === "openai" ? "https://api.openai.com/v1" : OPENCODE_GO_BASE_URL))}/models`;
    const data = modelsSchema.parse(await getJSON(deps, url, key ? { authorization: `Bearer ${key}` } : {}));
    const ids = idsOf(data.data, "id");
    return { ok: true, models: clean(id === "openai" ? ids.filter((m: unknown) => typeof m === "string" && !NOT_CHAT.test(m)) : ids), fixed: false };
  } catch (e) {
    if (e instanceof z.ZodError) return { ok: false, error: "The models endpoint returned an invalid response." };
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, error: timeout ? "The models endpoint did not answer in 10 seconds." : e instanceof Error ? e.message : String(e) };
  }
}
