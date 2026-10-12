import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type Config } from "../src/config.ts";
import type { GenerateRequest, Provider, ProviderCapabilities } from "../src/providers/types.ts";
import { createTurnHandler, type TurnStreamEvent } from "../src/server/turns.ts";
import { designDir } from "../src/workspace/paths.ts";

const caps: ProviderCapabilities = { vision: true, toolUse: true, promptCache: "explicit", maxContextTokens: 200_000, editsFiles: false };

let config: Config;
let server: ReturnType<typeof Bun.serve>;
let calls: { provider: string; req: GenerateRequest }[];
let behave: (req: GenerateRequest) => AsyncGenerator<any>;
let capabilities: ProviderCapabilities;

beforeEach(async () => {
  const workspace = await mkdtemp(join(tmpdir(), "doi-turns-"));
  config = parseConfig({
    workspace,
    models: { generate: "anthropic:big-model", edit: "openai:small-model" },
  });
  const dir = designDir(workspace, "p", "d");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "index.html"), '<h1 data-oid="title">Hi</h1>');
  await Bun.write(join(dir, "styles.css"), "h1 { color: red; }");
  calls = [];
  capabilities = caps;
  behave = async function* () {
    yield { type: "text", delta: "Blue now." };
    yield { type: "edit", file: "styles.css", oldText: "red", newText: "blue" };
    yield { type: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 };
    yield { type: "done" };
  };
  const handler = createTurnHandler({
    config,
    getProvider: (id) =>
      ({
        id,
        capabilities,
        generate(req: GenerateRequest) {
          calls.push({ provider: id, req });
          return behave(req);
        },
      }) as Provider,
  });
  server = Bun.serve({
    port: 0,
    idleTimeout: 1, // seconds; the default is 10
    routes: { "/api/projects/:project/designs/:design/turns": { POST: (req, srv) => handler(req, req.params, srv) } },
  });
});

afterEach(() => server.stop(true));

const url = (design = "d") => `${server.url}api/projects/p/designs/${design}/turns`;
const post = (body: unknown, init: RequestInit = {}, design = "d") =>
  fetch(url(design), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init });

async function events(res: Response): Promise<TurnStreamEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => JSON.parse(block.split("\n").find((l) => l.startsWith("data: "))!.slice(6)));
}

describe("POST turns", () => {
  test("streams text, edit, usage, applied and done, and applies the edit", async () => {
    const res = await post({ text: "Make it blue" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    const evs = await events(res);
    expect(evs.map((e) => e.type)).toEqual(["text", "edit", "usage", "applied", "done"]);
    expect(evs.find((e) => e.type === "applied")).toEqual({ type: "applied", files: ["styles.css"] });
    expect(await Bun.file(join(designDir(config.workspace, "p", "d"), "styles.css")).text()).toBe("h1 { color: blue; }");

    const req = calls[0]!.req;
    expect(calls[0]!.provider).toBe("anthropic");
    expect(req.model).toBe("big-model");
    expect(req.system[0]).toContain("data-oid");
    expect(req.system.at(-1)).toContain("h1 { color: red; }");
    expect(req.cwd).toBe(designDir(config.workspace, "p", "d"));
  });

  test("a target uses the edit model and goes into the message", async () => {
    await events(await post({ text: "Bigger", target: "title" }));
    expect(calls[0]!.provider).toBe("openai");
    expect(calls[0]!.req.model).toBe("small-model");
    expect(calls[0]!.req.messages.at(-1)!.content[0]).toEqual({ type: "text", text: 'Target: data-oid="title". Bigger' });
  });

  test("bad requests and unknown designs fail before any provider call", async () => {
    expect((await post({ text: "" })).status).toBe(400);
    expect((await post({ text: "x", target: "a b" })).status).toBe(400);
    expect((await post("just text")).status).toBe(400);
    expect((await fetch(url(), { method: "POST", body: "{not json" })).status).toBe(400);
    expect((await post({ text: "x" }, {}, "Bad_Name")).status).toBe(400);
    expect((await post({ text: "x" }, {}, "missing")).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("provider errors and a too-large context arrive as error events", async () => {
    behave = async function* () {
      throw new Error("Set ANTHROPIC_API_KEY to use the Anthropic provider.");
    };
    expect(await events(await post({ text: "x" }))).toEqual([
      { type: "error", kind: "provider", message: "Set ANTHROPIC_API_KEY to use the Anthropic provider." },
    ]);

    capabilities = { ...caps, maxContextTokens: 1_000 };
    const [e] = await events(await post({ text: "x" }));
    expect(e).toMatchObject({ type: "error", kind: "context" });
  });

  test("a second turn on the same design is refused while one runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    behave = async function* () {
      yield { type: "text", delta: "working" };
      await gate;
      yield { type: "done" };
    };
    const first = await post({ text: "one" });
    const second = await post({ text: "two" });
    expect(second.status).toBe(409);
    release();
    expect((await events(first)).map((e) => e.type)).toEqual(["text", "applied", "done"]);
    // The lock is free again.
    expect((await post({ text: "three" })).status).toBe(200);
  });

  test("stopping the request aborts the provider call and frees the design", async () => {
    let providerSignal: AbortSignal | undefined;
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    behave = async function* (req) {
      providerSignal = req.signal;
      yield { type: "text", delta: "working" };
      started();
      await new Promise((_, reject) =>
        req.signal!.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError"))),
      );
    };
    const client = new AbortController();
    const res = await post({ text: "long" }, { signal: client.signal });
    const reader = res.body!.getReader();
    await reader.read();
    await running;
    client.abort();

    for (let i = 0; i < 50 && !providerSignal?.aborted; i++) await Bun.sleep(10);
    expect(providerSignal?.aborted).toBe(true);
    let status = 409;
    for (let i = 0; i < 50 && status === 409; i++) {
      const res = await post({ text: "again" });
      status = res.status;
      await res.body?.cancel();
      if (status === 409) await Bun.sleep(10);
    }
    expect(status).toBe(200);
  });

  test("a quiet turn is not cut by the server idle timeout", async () => {
    behave = async function* () {
      yield { type: "text", delta: "thinking" };
      await Bun.sleep(5_000); // Bun closed the socket after about 4 s with idleTimeout 1
      yield { type: "text", delta: " done" };
      yield { type: "done" };
    };
    const evs = await events(await post({ text: "slow" }));
    expect(evs.map((e) => e.type)).toEqual(["text", "text", "applied", "done"]);
  }, 15_000);
});
