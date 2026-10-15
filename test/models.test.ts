import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { memoryKeyStore } from "../src/providers/keys.ts";
import { listModels, type ModelListDeps } from "../src/providers/models.ts";
import { getProviderModels } from "../src/server/settings.ts";

const config = parseConfig({}, "/tmp/doi");

/** A fetch that records each request and answers from `routes` (URL → JSON or status). */
function deps(routes: Record<string, unknown>, keys: Record<string, string> = {}, env: Record<string, string> = {}) {
  const calls: { url: string; headers: Headers }[] = [];
  const d: ModelListDeps = {
    env,
    keys: memoryKeyStore(keys),
    fetch: async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers) });
      const r = routes[url];
      if (r === undefined) return new Response("no", { status: 404 });
      return typeof r === "number" ? new Response("x", { status: r }) : Response.json(r);
    },
  };
  return { d, calls };
}

describe("listModels", () => {
  test("CLI backends give a fixed list and fetch nothing", async () => {
    const { d, calls } = deps({});
    expect(await listModels("claude-code", config, d)).toMatchObject({ ok: true, fixed: true, models: expect.arrayContaining(["claude-opus-5-5"]) });
    expect(await listModels("codex", config, d)).toEqual({ ok: true, fixed: true, models: ["default"] });
    expect(calls).toHaveLength(0);
  });

  test("OpenCode Go: the models endpoint with the stored key", async () => {
    const { d, calls } = deps(
      { "https://opencode.ai/inference/go/v1/models": { data: [{ id: "glm-5.3" }, { id: "kimi-k3" }, { id: "glm-5.3" }, { id: "--flag" }, { id: 7 }] } },
      { "opencode-go": "sk-go" },
    );
    expect(await listModels("opencode-go", config, d)).toEqual({ ok: true, fixed: false, models: ["glm-5.3", "kimi-k3"] });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer sk-go");
  });

  test("OpenCode Go lists without a key; base_url is used", async () => {
    const c = parseConfig({ providers: { "opencode-go": { base_url: "https://proxy.example/v1/" } } }, "/tmp/doi");
    const { d, calls } = deps({ "https://proxy.example/v1/models": { data: [{ id: "glm-5.3" }] } });
    expect(await listModels("opencode-go", c, d)).toMatchObject({ ok: true, models: ["glm-5.3"] });
    expect(calls[0]!.headers.has("authorization")).toBe(false);
  });

  test("Anthropic: x-api-key, version header and pages", async () => {
    const { d, calls } = deps(
      {
        "https://api.anthropic.com/v1/models?limit=1000": { data: [{ id: "claude-opus-5-5" }], has_more: true, last_id: "claude-opus-5-5" },
        "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-5-5": { data: [{ id: "claude-haiku-5-5" }], has_more: false },
      },
      {},
      { ANTHROPIC_API_KEY: "sk-ant" },
    );
    expect(await listModels("anthropic", config, d)).toEqual({ ok: true, fixed: false, models: ["claude-haiku-5-5", "claude-opus-5-5"] });
    expect(calls[0]!.headers.get("x-api-key")).toBe("sk-ant");
    expect(calls[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
  });

  test("OpenAI: only chat models", async () => {
    const { d } = deps(
      { "https://api.openai.com/v1/models": { data: ["gpt-6", "text-embedding-3-large", "whisper-1", "gpt-6-realtime", "o5"].map((id) => ({ id })) } },
      { openai: "sk-oa" },
    );
    expect(await listModels("openai", config, d)).toMatchObject({ ok: true, models: ["gpt-6", "o5"] });
  });

  test("Ollama: the local tags", async () => {
    const { d } = deps({ "http://localhost:11434/api/tags": { models: [{ name: "qwen3:14b" }, { name: "llama4:latest" }] } });
    expect(await listModels("ollama", config, d)).toMatchObject({ ok: true, models: ["llama4:latest", "qwen3:14b"] });
  });

  test("errors: no key, refused key, bad status, no adapter; never the key", async () => {
    expect(await listModels("openai", config, deps({}).d)).toEqual({ ok: false, error: "Add an API key to list the models." });
    const refused = await listModels("anthropic", config, deps({ "https://api.anthropic.com/v1/models?limit=1000": 401 }, { anthropic: "sk-secret" }).d);
    expect(refused).toEqual({ ok: false, error: "The provider refused the API key (401)." });
    expect(await listModels("openai", config, deps({ "https://api.openai.com/v1/models": 500 }, { openai: "sk" }).d)).toEqual({
      ok: false,
      error: "The models endpoint answered 500.",
    });
    expect((await listModels("google", config, deps({}).d)).ok).toBe(false);
  });
});

test("GET /api/providers/:id/models", async () => {
  const { d } = deps({ "https://opencode.ai/inference/go/v1/models": { data: [{ id: "glm-5.3" }] } }, { "opencode-go": "sk-hidden" });
  const res = await getProviderModels(config, { id: "opencode-go" }, d);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ models: ["glm-5.3"], fixed: false });
  expect(text).not.toContain("sk-hidden");
  expect((await getProviderModels(config, { id: "nobody" }, d)).status).toBe(404);
  expect((await getProviderModels(config, { id: "openai" }, d)).status).toBe(502);
});
