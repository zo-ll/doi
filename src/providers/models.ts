import { MODEL_NAME, type Config, type ProviderId } from "../config.ts";
import { keyStore, resolveKey, type KeyStore } from "./keys.ts";
import { DOI_USER_AGENT, OPENCODE_GO_BASE_URL } from "./opencode-go.ts";

/**
 * The models a provider offers, for the model field in Settings. API providers answer from their
 * models endpoint with the key (on the server only; the UI gets ids). The CLI backends have no
 * command that lists models, so they get a fixed list; the field stays free text.
 */
export type ModelList = { ok: true; models: string[]; fixed: boolean } | { ok: false; error: string };

export interface ModelListDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: Record<string, string | undefined>;
  keys: KeyStore;
}

export const defaultModelListDeps: ModelListDeps = {
  fetch: (url, init) => fetch(url, init),
  env: process.env,
  get keys() {
    return keyStore();
  },
};

/** Claude Code takes these ids with --model; "default" uses the model from the Codex config. */
const FIXED: Partial<Record<ProviderId, string[]>> = {
  "claude-code": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  codex: ["default"],
};

/** OpenAI lists every model; these are not chat models. */
const NOT_CHAT = /embed|tts|whisper|dall-e|moderation|transcribe|audio|realtime|image|search|davinci|babbage/i;

const TIMEOUT_MS = 10_000;
const MAX_PAGES = 5;

const trim = (url: string) => url.replace(/\/+$/, "");

/** Ids that the model field takes, sorted and without doubles. */
function clean(ids: unknown[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && MODEL_NAME.test(id)))].sort();
}

async function getJSON(deps: ModelListDeps, url: string, headers: Record<string, string>): Promise<any> {
  const res = await deps.fetch(url, { headers: { "user-agent": DOI_USER_AGENT, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 401 || res.status === 403) throw new Error(`The provider refused the API key (${res.status}).`);
  if (!res.ok) throw new Error(`The models endpoint answered ${res.status}.`);
  return res.json();
}

export async function listModels(id: ProviderId, config: Config, deps: ModelListDeps = defaultModelListDeps): Promise<ModelList> {
  const fixed = FIXED[id];
  if (fixed) return { ok: true, models: fixed, fixed: true };
  const base = config.providers[id]?.base_url;
  try {
    if (id === "ollama") {
      const data = await getJSON(deps, `${trim(base ?? "http://localhost:11434")}/api/tags`, {});
      return { ok: true, models: clean((data?.models ?? []).map((m: any) => m?.name)), fixed: false };
    }
    if (id !== "anthropic" && id !== "openai" && id !== "opencode-go") return { ok: false, error: "doi has no adapter for this provider yet." };

    const key = (await resolveKey(id, config, deps.env, deps.keys))?.value;
    // OpenCode Go lists its models without a key; the other two need one.
    if (!key && id !== "opencode-go") return { ok: false, error: "Add an API key to list the models." };

    if (id === "anthropic") {
      const ids: unknown[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const q = new URLSearchParams({ limit: "1000", ...(after ? { after_id: after } : {}) });
        const data = await getJSON(deps, `${trim(base ?? "https://api.anthropic.com/v1")}/models?${q}`, {
          "x-api-key": key!,
          "anthropic-version": "2023-06-01",
        });
        ids.push(...(data?.data ?? []).map((m: any) => m?.id));
        if (!data?.has_more || typeof data.last_id !== "string") break;
        after = data.last_id;
      }
      return { ok: true, models: clean(ids), fixed: false };
    }

    const url = `${trim(base ?? (id === "openai" ? "https://api.openai.com/v1" : OPENCODE_GO_BASE_URL))}/models`;
    const data = await getJSON(deps, url, key ? { authorization: `Bearer ${key}` } : {});
    const ids = (data?.data ?? []).map((m: any) => m?.id);
    return { ok: true, models: clean(id === "openai" ? ids.filter((m: unknown) => typeof m === "string" && !NOT_CHAT.test(m)) : ids), fixed: false };
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, error: timeout ? "The models endpoint did not answer in 10 seconds." : e instanceof Error ? e.message : String(e) };
  }
}
