import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { createOpenAI } from "../src/providers/openai.ts";
import type { GenerateEvent, GenerateRequest } from "../src/providers/types.ts";

const KEY = "test-openai-key";
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = KEY;
});
afterEach(() => {
  if (saved === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = saved;
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

const req: GenerateRequest = {
  model: "gpt-6",
  system: ["rules", "stable context"],
  messages: [{ role: "user", content: [{ type: "text", text: "A pricing page" }] }],
};

async function collect(gen: AsyncIterable<GenerateEvent>) {
  const out: GenerateEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const config = parseConfig({}, "/tmp/doi");

describe("openai provider requests", () => {
  test("calls the Responses API with the key, the system parts and both tools", async () => {
    const { fn, calls } = fakeFetch();
    await expect(collect(createOpenAI(config, { fetch: fn }).generate(req))).rejects.toThrow("stop here");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body.model).toBe("gpt-6");
    const input = calls[0]!.body.input as { role: string; content: unknown }[];
    // Reasoning models take the system parts as "developer" messages, in order and before the chat.
    expect(input.slice(0, 2)).toEqual([
      { role: "developer", content: "rules" },
      { role: "developer", content: "stable context" },
    ]);
    expect(calls[0]!.body.tools.map((t: any) => t.name).sort()).toEqual(["edit", "write"]);
  });

  test("api_key_env and base_url come from config.toml", async () => {
    process.env.DOI_TEST_OPENAI_KEY = "other-key";
    try {
      const c = parseConfig(
        { providers: { openai: { api_key_env: "DOI_TEST_OPENAI_KEY", base_url: "https://proxy.example/v1" } } },
        "/tmp/doi",
      );
      const { fn, calls } = fakeFetch();
      await expect(collect(createOpenAI(c, { fetch: fn }).generate(req))).rejects.toThrow();
      expect(calls[0]!.url).toBe("https://proxy.example/v1/responses");
      expect(calls[0]!.headers.get("authorization")).toBe("Bearer other-key");
    } finally {
      delete process.env.DOI_TEST_OPENAI_KEY;
    }
  });

  test("a missing key fails before any request", async () => {
    delete process.env.OPENAI_API_KEY;
    const { fn, calls } = fakeFetch();
    await expect(collect(createOpenAI(config, { fetch: fn }).generate(req))).rejects.toThrow("No API key for the OpenAI API");
    expect(calls).toHaveLength(0);
  });
});

describe("openai responses stream", () => {
  test("a streamed response maps to text, edit, write, usage with cached tokens, and done", async () => {
    const event = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
    const call = (index: number, id: string, name: string, args: object) =>
      event({
        type: "response.output_item.done",
        output_index: index,
        item: { type: "function_call", id, call_id: `call_${id}`, name, arguments: JSON.stringify(args), status: "completed" },
      });
    const sse =
      event({ type: "response.created", response: { id: "r1", created_at: 0, model: "gpt-6" } }) +
      event({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m1" } }) +
      event({ type: "response.output_text.delta", item_id: "m1", output_index: 0, delta: "On it." }) +
      event({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m1" } }) +
      call(1, "f1", "edit", { file: "styles.css", oldText: "red", newText: "blue" }) +
      call(2, "f2", "write", { file: "about.html", content: "<h1>About</h1>" }) +
      event({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 500,
            input_tokens_details: { cached_tokens: 400 },
            output_tokens: 40,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      });
    const { fn } = fakeFetch(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));

    const events = await collect(createOpenAI(config, { fetch: fn }).generate(req));
    expect(events).toEqual([
      { type: "text", delta: "On it." },
      { type: "edit", file: "styles.css", oldText: "red", newText: "blue" },
      { type: "write", file: "about.html", content: "<h1>About</h1>" },
      { type: "usage", inputTokens: 500, outputTokens: 40, cachedTokens: 400 },
      { type: "done" },
    ]);
  });
});
