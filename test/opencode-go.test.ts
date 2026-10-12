import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { createOpenCodeGo, OPENCODE_GO_BASE_URL } from "../src/providers/opencode-go.ts";
import { supportsVision, wireFormat } from "../src/providers/opencode-go-formats.ts";
import type { GenerateEvent, GenerateRequest } from "../src/providers/types.ts";

const KEY = "test-opencode-key";
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = KEY;
});
afterEach(() => {
  if (saved === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = saved;
});

interface Captured {
  url: string;
  headers: Headers;
  body: any;
}

/** A fetch that records the request and answers with `respond`. */
function fakeFetch(respond: () => Response = () => Response.json({ error: { message: "stop here" } }, { status: 400 })) {
  const calls: Captured[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, headers: req.headers, body: await req.json() });
    return respond();
  }) as typeof fetch;
  return { fn, calls };
}

const req = (model: string): GenerateRequest => ({
  model,
  system: ["rules", "stable context"],
  messages: [{ role: "user", content: [{ type: "text", text: "A pricing page" }] }],
});

async function collect(gen: AsyncIterable<GenerateEvent>) {
  const out: GenerateEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const config = parseConfig({}, "/tmp/doi");

describe("wire formats", () => {
  test("known models, prefix rules and the chat default", () => {
    expect(wireFormat("glm-5.3")).toBe("chat");
    expect(wireFormat("deepseek-v4.1-flash")).toBe("chat");
    expect(wireFormat("claude-haiku-5-5")).toBe("messages");
    expect(wireFormat("minimax-m3")).toBe("messages");
    expect(wireFormat("gpt-6-luna")).toBe("responses");
    expect(wireFormat("grok-9-future")).toBe("responses");
    expect(wireFormat("qwen4-max")).toBe("messages");
    expect(wireFormat("brand-new-model")).toBe("chat");
  });

  test("config overrides win, and a bad override is an error", () => {
    expect(wireFormat("glm-5.3", { "glm-5.3": "messages" })).toBe("messages");
    expect(() => wireFormat("glm-5.3", { "glm-5.3": "grpc" })).toThrow('Unknown OpenCode Go format "grpc"');
  });

  test("model ids that name Object.prototype properties are plain models", () => {
    for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(wireFormat(id)).toBe("chat");
      expect(wireFormat(id, {})).toBe("chat");
    }
  });

  test("vision", () => {
    expect(supportsVision("claude-haiku-5-5", "messages")).toBe(true);
    expect(supportsVision("glm-5.3", "chat")).toBe(false);
    expect(supportsVision("deepseek-v4-flash-vision-exp", "chat")).toBe(true);
  });
});

describe("opencode-go provider requests", () => {
  const cases = [
    { model: "glm-5.3", path: "/chat/completions", auth: ["authorization", `Bearer ${KEY}`] },
    { model: "claude-haiku-5-5", path: "/messages", auth: ["x-api-key", KEY] },
    { model: "gpt-6-luna", path: "/responses", auth: ["authorization", `Bearer ${KEY}`] },
  ] as const;

  for (const c of cases) {
    test(`${c.model} calls ${c.path} with the key`, async () => {
      const { fn, calls } = fakeFetch();
      await expect(collect(createOpenCodeGo(config, { fetch: fn }).generate(req(c.model)))).rejects.toThrow();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`${OPENCODE_GO_BASE_URL}${c.path}`);
      expect(calls[0]!.headers.get(c.auth[0])).toBe(c.auth[1]);
      expect(calls[0]!.body.model).toBe(c.model);
    });
  }

  test("the messages format sends the cache marker on the last system part", async () => {
    const { fn, calls } = fakeFetch();
    await expect(collect(createOpenCodeGo(config, { fetch: fn }).generate(req("claude-haiku-5-5")))).rejects.toThrow();
    const system = calls[0]!.body.system as { text: string; cache_control?: unknown }[];
    expect(system.map((s) => s.text)).toEqual(["rules", "stable context"]);
    expect(system[0]!.cache_control).toBeUndefined();
    expect(system[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("base_url and formats come from config.toml", async () => {
    const c = parseConfig(
      { providers: { "opencode-go": { base_url: "https://proxy.example/v1", formats: { "glm-5.3": "messages" } } } },
      "/tmp/doi",
    );
    const { fn, calls } = fakeFetch();
    await expect(collect(createOpenCodeGo(c, { fetch: fn }).generate(req("glm-5.3")))).rejects.toThrow();
    expect(calls[0]!.url).toBe("https://proxy.example/v1/messages");
  });

  test("a missing key fails before any request", async () => {
    delete process.env.OPENCODE_API_KEY;
    const { fn, calls } = fakeFetch();
    await expect(collect(createOpenCodeGo(config, { fetch: fn }).generate(req("glm-5.3")))).rejects.toThrow(
      "Set OPENCODE_API_KEY",
    );
    expect(calls).toHaveLength(0);
  });

  test("capabilities follow the model", () => {
    const p = createOpenCodeGo(config);
    expect(p.forModel!("claude-haiku-5-5")).toMatchObject({ vision: true, promptCache: "explicit" });
    expect(p.forModel!("glm-5.3")).toMatchObject({ vision: false, promptCache: "automatic" });
  });
});

describe("opencode-go chat stream", () => {
  test("a streamed chat completion maps to text, edit, usage and done", async () => {
    const chunk = (delta: object, finish: string | null = null, usage?: object) =>
      `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 0,
        model: "glm-5.3",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      })}\n\n`;
    const args = JSON.stringify({ file: "styles.css", oldText: "red", newText: "blue" });
    const sse =
      chunk({ role: "assistant", content: "On it." }) +
      chunk({ tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "edit", arguments: args } }] }) +
      chunk({}, "tool_calls") +
      chunk({}, null, { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 }) +
      "data: [DONE]\n\n";
    const { fn } = fakeFetch(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));

    const events = await collect(createOpenCodeGo(config, { fetch: fn }).generate(req("glm-5.3")));
    expect(events).toEqual([
      { type: "text", delta: "On it." },
      { type: "edit", file: "styles.css", oldText: "red", newText: "blue" },
      { type: "usage", inputTokens: 50, outputTokens: 12, cachedTokens: 0 },
      { type: "done" },
    ]);
  });
});
