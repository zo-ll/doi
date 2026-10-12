import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type Config } from "../src/config.ts";
import type { GenerateRequest, Provider, ProviderCapabilities } from "../src/providers/types.ts";
import { createTurnHandler, getChat, type TurnStreamEvent } from "../src/server/turns.ts";
import { readChat } from "../src/workspace/chat.ts";
import { designDir } from "../src/workspace/paths.ts";

const caps: ProviderCapabilities = { vision: true, toolUse: true, promptCache: "explicit", maxContextTokens: 200_000, editsFiles: false };

let config: Config;
let server: ReturnType<typeof Bun.serve>;
let calls: { provider: string; req: GenerateRequest }[];
let behave: (req: GenerateRequest) => AsyncGenerator<any>;
let capabilities: ProviderCapabilities;
let commits: string[];
let commitResult: () => Promise<string | null>;

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
  commits = [];
  commitResult = async () => "a".repeat(40);
  capabilities = caps;
  behave = async function* () {
    yield { type: "text", delta: "Blue now." };
    yield { type: "edit", file: "styles.css", oldText: "red", newText: "blue" };
    yield { type: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 };
    yield { type: "done" };
  };
  const handler = createTurnHandler({
    config,
    commit: (project, design, prompt) => {
      commits.push(`${project}/${design}: ${prompt}`);
      return commitResult();
    },
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
    expect(evs.map((e) => e.type)).toEqual(["text", "edit", "usage", "applied", "done", "commit"]);
    expect(evs.find((e) => e.type === "applied")).toEqual({ type: "applied", files: ["styles.css"] });
    expect(evs.at(-1)).toEqual({ type: "commit", sha: "a".repeat(40) });
    expect(commits).toEqual(["p/d: Make it blue"]);
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
    // No files changed: no commit.
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
    const stored = (await readChat(config.workspace, "p", "d")).find((e) => e.role === "assistant");
    expect(stored).toMatchObject({ status: "stopped", text: "working" });
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

  test("each turn is stored, and completed turns are the history of the next", async () => {
    await events(await post({ text: "Make it blue" }));
    let entries = await readChat(config.workspace, "p", "d");
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant"]);
    expect(entries[1]).toMatchObject({
      status: "done",
      text: "Blue now.",
      provider: "anthropic",
      model: "big-model",
      files: ["styles.css"],
      usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
      prompt: "v0",
    });

    await events(await post({ text: "Now bigger", target: "title" }));
    const texts = calls[1]!.req.messages.map((m) => `${m.role}: ${(m.content[0] as { text: string }).text}`);
    expect(texts).toEqual([
      "user: Make it blue",
      "assistant: Blue now.",
      'user: Target: data-oid="title". Now bigger',
    ]);

    const res = await getChat(config.workspace, { project: "p", design: "d" });
    entries = await res.json();
    expect(entries).toHaveLength(4);
    expect((await getChat(config.workspace, { project: "p", design: "Bad" })).status).toBe(400);
  });

  test("failed and stopped turns are stored with their status", async () => {
    behave = async function* () {
      throw new Error("rate limit");
    };
    await events(await post({ text: "x" }));
    capabilities = { ...caps, maxContextTokens: 1_000 };
    await events(await post({ text: "y" }));
    const entries = await readChat(config.workspace, "p", "d");
    expect(entries.filter((e) => e.role === "assistant")).toMatchObject([
      { status: "error", error: "rate limit" },
      { status: "error", error: expect.stringContaining("tokens") },
    ]);
  });

  test("a failed turn makes no commit, and a failed commit is reported after done", async () => {
    behave = async function* () {
      throw new Error("rate limit");
    };
    await events(await post({ text: "x" }));
    expect(commits).toEqual([]);

    behave = async function* () {
      yield { type: "edit", file: "styles.css", oldText: "red", newText: "blue" };
      yield { type: "done" };
    };
    commitResult = async () => {
      throw new Error("git commit failed: Please tell me who you are");
    };
    const evs = await events(await post({ text: "y" }));
    expect(evs.slice(-2)).toEqual([
      { type: "done" },
      { type: "commit", sha: null, error: "git commit failed: Please tell me who you are" },
    ]);
  });

  test("images are saved, stored in the chat and sent as image parts", async () => {
    const png = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
    const evs = await events(await post({ text: "Like this", images: [{ mediaType: "image/png", data: png.toString("base64") }] }));
    expect(evs.at(-1)!.type).toBe("commit");
    const last = calls[0]!.req.messages.at(-1)!;
    expect(last.content[1]).toEqual({ type: "image", mediaType: "image/png", data: new Uint8Array(png) });
    const [user] = await readChat(config.workspace, "p", "d");
    const names = user?.role === "user" ? (user.images ?? []) : [];
    expect(names).toHaveLength(1);
    const name = names[0]!;
    expect(name).toMatch(/^[0-9a-f-]{36}-0\.png$/);
    expect(Buffer.from(await Bun.file(join(config.workspace, "projects", "p", "uploads", name)).arrayBuffer())).toEqual(png);

    // The next turn does not send the old image again; it only says that there was one.
    await events(await post({ text: "Now bigger" }));
    expect(calls[1]!.req.messages[0]!.content).toEqual([{ type: "text", text: "Like this\n\n(1 image attached to this message.)" }]);
  });

  test("bad images fail before any provider call", async () => {
    const img = (mediaType: string, data: string) => ({ mediaType, data });
    const ok = Buffer.from([1]).toString("base64");
    for (const images of [
      "x",
      [img("image/svg+xml", ok)],
      [img("image/png", "")],
      Array.from({ length: 6 }, () => img("image/png", ok)),
      [img("image/png", Buffer.alloc(3_750_001).toString("base64"))],
    ]) {
      const res = await post({ text: "x", images });
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test("a model without vision refuses images with a clear message", async () => {
    capabilities = { ...caps, vision: false };
    const res = await post({ text: "x", images: [{ mediaType: "image/png", data: "AQ==" }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("anthropic:big-model cannot read images. Remove the images, or choose a model with vision in config.toml.");
    expect(calls).toHaveLength(0);
    // The design is not locked by the refused request.
    expect((await post({ text: "no images" })).status).toBe(200);
  });
});
