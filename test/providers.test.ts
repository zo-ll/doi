import { describe, expect, test } from "bun:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { parseConfig } from "../src/config.ts";
import { createAnthropic } from "../src/providers/anthropic.ts";
import { fileOfPartialInput, ProviderError, streamDesign, toInstructions, toModelMessages } from "../src/providers/ai-sdk.ts";
import { SEARCH_REPLACE_PROMPT } from "../src/providers/search-replace.ts";
import type { GenerateEvent, GenerateRequest } from "../src/providers/types.ts";

const usage = {
  inputTokens: { total: 120, noCache: 20, cacheRead: 100, cacheWrite: undefined },
  outputTokens: { total: 30, text: 30, reasoning: undefined },
};
const finish = { type: "finish", finishReason: { unified: "stop", raw: undefined }, logprobs: undefined, usage } as const;

function mockModel(chunks: unknown[]) {
  const calls: any[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options: any) => {
      calls.push(options);
      return { stream: simulateReadableStream({ chunks: chunks as any[] }) };
    },
  });
  return { model, calls };
}

test("a turn that reaches the output limit fails after it reports its tokens", async () => {
  const { model } = mockModel([{ type: "stream-start", warnings: [] }, { ...finish, finishReason: { unified: "length", raw: "length" } }]);
  const seen: string[] = [];
  const run = async () => {
    for await (const e of streamDesign(model, { ...req, signal: new AbortController().signal }, { toolUse: true })) seen.push(e.type);
  };
  await expect(run()).rejects.toBeInstanceOf(ProviderError);
  expect(seen).toEqual(["usage"]);
  await expect(run()).rejects.toThrow("output limit");
});

const req: GenerateRequest = {
  model: "test-model",
  system: ["rules", "design system and current files"],
  messages: [{ role: "user", content: [{ type: "text", text: "Make the button blue" }] }],
};

const TOOLS = { toolUse: true };
const NO_TOOLS = { toolUse: false };

async function collect(gen: AsyncIterable<GenerateEvent>): Promise<GenerateEvent[]> {
  const out: GenerateEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("streamDesign without tool use (#58)", () => {
  const text = (deltas: string[]) => [
    { type: "text-start", id: "t1" },
    ...deltas.map((delta) => ({ type: "text-delta", id: "t1", delta })),
    { type: "text-end", id: "t1" },
    finish,
  ];

  test("sends no tools, asks for blocks after the system prompt, and parses them", async () => {
    const { model, calls } = mockModel(
      text(["Bluer button.\nstyles.css\n<<<<<<< SEA", "RCH\n--accent: red\n=======\n--accent: blue\n>>>>>>> REPLACE\n", "Done."]),
    );
    const events = await collect(streamDesign(model, req, NO_TOOLS));
    expect(events).toEqual([
      { type: "text", delta: "Bluer button.\n" },
      { type: "edit", file: "styles.css", oldText: "--accent: red", newText: "--accent: blue" },
      { type: "text", delta: "Done." },
      { type: "usage", inputTokens: 120, outputTokens: 30, cachedTokens: 100 },
      { type: "done" },
    ]);
    expect(calls[0].tools ?? []).toEqual([]);
    const system = calls[0].prompt.filter((m: any) => m.role === "system").map((m: any) => m.content);
    expect(system).toEqual(["rules", SEARCH_REPLACE_PROMPT.text, "design system and current files"]);
  });

  test("a broken block is a ProviderError", async () => {
    const { model } = mockModel(text(["styles.css\n<<<<<<< SEARCH\n--accent: red\n"]));
    await expect(collect(streamDesign(model, req, NO_TOOLS))).rejects.toThrow(ProviderError);
  });

  test("with tool use, block text stays text", async () => {
    const { model, calls } = mockModel(text(["styles.css\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n"]));
    const events = await collect(streamDesign(model, req, TOOLS));
    expect(events.filter((e) => e.type === "edit")).toEqual([]);
    expect(calls[0].tools.map((t: any) => t.name)).toEqual(["edit", "write"]);
  });
});

describe("streamDesign", () => {
  test("maps text, edit and write calls, usage and done", async () => {
    const { model } = mockModel([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Changing " },
      { type: "text-delta", id: "t1", delta: "the button." },
      { type: "text-end", id: "t1" },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "edit",
        input: JSON.stringify({ file: "styles.css", oldText: "--accent: red", newText: "--accent: blue" }),
      },
      {
        type: "tool-call",
        toolCallId: "c2",
        toolName: "write",
        input: JSON.stringify({ file: "about.html", content: "<h1>About</h1>" }),
      },
      finish,
    ]);

    expect(await collect(streamDesign(model, req, TOOLS))).toEqual([
      { type: "text", delta: "Changing " },
      { type: "text", delta: "the button." },
      { type: "edit", file: "styles.css", oldText: "--accent: red", newText: "--accent: blue" },
      { type: "write", file: "about.html", content: "<h1>About</h1>" },
      { type: "usage", inputTokens: 120, outputTokens: 30, cachedTokens: 100 },
      { type: "done" },
    ]);
  });

  test("a streaming tool input gives one progress event with its file, before the call", async () => {
    const input = JSON.stringify({ file: "pages/a \"b\".html", content: "<h1>x</h1>" });
    const { model } = mockModel([
      { type: "tool-input-start", id: "c1", toolName: "write" },
      { type: "tool-input-delta", id: "c1", delta: input.slice(0, 12) },
      { type: "tool-input-delta", id: "c1", delta: input.slice(12, 30) },
      { type: "tool-input-delta", id: "c1", delta: input.slice(30) },
      { type: "tool-input-end", id: "c1" },
      { type: "tool-call", toolCallId: "c1", toolName: "write", input },
      finish,
    ]);
    const events = await collect(streamDesign(model, req, TOOLS));
    expect(events.slice(0, 2)).toEqual([
      { type: "progress", file: 'pages/a "b".html' },
      { type: "write", file: 'pages/a "b".html', content: "<h1>x</h1>" },
    ]);
  });

  test("fileOfPartialInput waits for the closing quote of the file", () => {
    expect(fileOfPartialInput('{"fi')).toBeNull();
    expect(fileOfPartialInput('{"file": "sty')).toBeNull();
    expect(fileOfPartialInput('{"file": "styles.css"')).toBe("styles.css");
    expect(fileOfPartialInput('{"content": "say \\"file\\": \\"x\\"", "file": "a.html"}')).toBe("a.html");
  });

  test("fails on a tool call that does not match the schema", async () => {
    const { model } = mockModel([
      { type: "tool-call", toolCallId: "c1", toolName: "edit", input: JSON.stringify({ file: "a.css" }) },
      finish,
    ]);
    await expect(collect(streamDesign(model, req, TOOLS))).rejects.toBeInstanceOf(ProviderError);
  });

  test("fails on a stream error", async () => {
    const { model } = mockModel([{ type: "error", error: new Error("overloaded") }]);
    await expect(collect(streamDesign(model, req, TOOLS))).rejects.toThrow("overloaded");
  });

  test("an aborted signal stops the run with an AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    const { model } = mockModel([{ type: "text-start", id: "t1" }, finish]);
    await expect(collect(streamDesign(model, { ...req, signal: controller.signal }, TOOLS))).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("sends system parts as separate messages, each with the cache marker", async () => {
    const { model, calls } = mockModel([finish]);
    const marker = { anthropic: { cacheControl: { type: "ephemeral" } } };
    await collect(streamDesign(model, req, TOOLS, marker));

    const system = calls[0].prompt.filter((m: any) => m.role === "system");
    expect(system.map((m: any) => m.content)).toEqual(["rules", "design system and current files"]);
    expect(system[0].providerOptions).toEqual(marker);
    expect(system[1].providerOptions).toEqual(marker);
    expect(calls[0].tools.map((t: any) => t.name).sort()).toEqual(["edit", "write"]);
  });
});

describe("request mapping", () => {
  test("more system parts than breakpoints put the markers on the last four", () => {
    const marker = { anthropic: { cacheControl: { type: "ephemeral" } } };
    const marked = toInstructions(["a", "b", "c", "d", "e"], marker).map((m) => m.providerOptions !== undefined);
    expect(marked).toEqual([false, true, true, true, true]);
  });

  test("no cache marker leaves all system messages plain", () => {
    expect(toInstructions(["a", "b"])).toEqual([
      { role: "system", content: "a" },
      { role: "system", content: "b" },
    ]);
  });

  test("images become file parts and assistant text is joined", () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(
      toModelMessages([
        { role: "user", content: [{ type: "text", text: "like this" }, { type: "image", mediaType: "image/png", data }] },
        { role: "assistant", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
      ]),
    ).toEqual([
      { role: "user", content: [{ type: "text", text: "like this" }, { type: "file", mediaType: "image/png", data }] },
      { role: "assistant", content: "one\ntwo" },
    ]);
  });
});

describe("anthropic provider", () => {
  test("needs the API key from the configured environment variable", async () => {
    const config = parseConfig({ providers: { anthropic: { api_key_env: "DOI_TEST_MISSING_KEY" } } });
    const provider = createAnthropic(config);
    expect(provider.capabilities.promptCache).toBe("explicit");
    await expect(collect(provider.generate(req))).rejects.toThrow("or set DOI_TEST_MISSING_KEY.");
  });
});
