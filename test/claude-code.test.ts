import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { parseConfig } from "../src/config.ts";
import { claudeArgs, createClaudeCode, mapEvent, userInput, type Proc, type Spawn } from "../src/providers/claude-code.ts";
import type { GenerateEvent, GenerateRequest } from "../src/providers/types.ts";

const CWD = "/ws/projects/sample/designs/home";
const config = parseConfig({}, "/tmp/doi");

const textDelta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const toolUse = (name: string, input: object) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name, input }] } });
const result = (over: object = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  usage: { input_tokens: 6, cache_creation_input_tokens: 2807, cache_read_input_tokens: 11285, output_tokens: 291 },
  ...over,
});

/** A fake `claude` process: replays `events` as stream-json lines and records what doi sent. */
function fakeSpawn(events: object[], opts: { exitCode?: number; stderr?: string; hang?: boolean } = {}) {
  const seen = { cmd: [] as string[], cwd: "", stdin: "", killed: false, systemFile: "", system: "", mode: 0 };
  const spawn: Spawn = (cmd, cwd) => {
    seen.cmd = cmd;
    seen.cwd = cwd;
    seen.systemFile = cmd[cmd.indexOf("--append-system-prompt-file") + 1]!;
    seen.system = readFileSync(seen.systemFile, "utf8");
    seen.mode = statSync(seen.systemFile).mode & 0o777;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const stdout = new ReadableStream<Uint8Array>({
      async start(c) {
        const enc = new TextEncoder();
        for (const e of events) c.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        if (opts.hang) await gate;
        c.close();
      },
    });
    const proc: Proc = {
      stdin: { write: (d: string) => (seen.stdin += d), end: () => {} },
      stdout,
      stderr: new Response(opts.stderr ?? "").body!,
      exited: opts.hang ? gate.then(() => 143) : Promise.resolve(opts.exitCode ?? 0),
      kill: () => {
        seen.killed = true;
        release();
      },
    };
    return proc;
  };
  return { spawn, seen };
}

const req = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  model: "sonnet",
  system: ["design rules", "current files"],
  messages: [{ role: "user", content: [{ type: "text", text: "Make the button blue" }] }],
  cwd: CWD,
  ...over,
});

async function collect(gen: AsyncIterable<GenerateEvent>) {
  const out: GenerateEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("claude-code provider", () => {
  test("runs claude -p in the design folder and maps the events", async () => {
    const { spawn, seen } = fakeSpawn([
      { type: "system", subtype: "init", tools: ["Edit", "Read", "Write"] },
      textDelta("Changing "),
      textDelta("the button."),
      toolUse("Read", { file_path: `${CWD}/styles.css` }),
      toolUse("Edit", { file_path: `${CWD}/styles.css`, old_string: "red", new_string: "blue", replace_all: false }),
      toolUse("Write", { file_path: `${CWD}/about.html`, content: "<h1>About</h1>" }),
      { type: "rate_limit_event" },
      result(),
    ]);
    const events = await collect(createClaudeCode(config, spawn).generate(req()));

    expect(seen.cwd).toBe(CWD);
    expect(seen.cmd[0]).toBe("claude");
    expect(events).toEqual([
      { type: "text", delta: "Changing " },
      { type: "text", delta: "the button." },
      { type: "edit", file: "styles.css", oldText: "red", newText: "blue" },
      { type: "write", file: "about.html", content: "<h1>About</h1>" },
      { type: "usage", inputTokens: 6 + 2807 + 11285, outputTokens: 291, cachedTokens: 11285 },
      { type: "done" },
    ]);
  });

  test("the command is restricted to file tools in the design folder", () => {
    const args = claudeArgs("opus", "/tmp/doi-claude-x/system.md");
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(args).toContain("--restricted");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(flag("--tools")).toBe("Read,Edit,Write");
    expect(flag("--permission-mode")).toBe("acceptEdits");
    expect(flag("--model")).toBe("opus");
    expect(flag("--append-system-prompt-file")).toBe("/tmp/doi-claude-x/system.md");
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("--bare"); // --bare skips keychain reads, which the subscription login needs
  });

  test("the system text goes in a private file outside the design folder, removed after the run", async () => {
    const big = "x".repeat(300_000); // larger than one Linux argv string (about 128 KB)
    const { spawn, seen } = fakeSpawn([result()]);
    await collect(createClaudeCode(config, spawn).generate(req({ system: ["rules", big] })));

    expect(seen.system).toBe(`rules\n\n${big}`);
    expect(seen.mode).toBe(0o600);
    expect(seen.systemFile.startsWith(CWD)).toBe(false);
    expect(seen.cmd.some((a) => a.length > 1000)).toBe(false);
    expect(existsSync(seen.systemFile)).toBe(false);
  });

  test("the system file is removed after a failed run", async () => {
    const { spawn, seen } = fakeSpawn([], { exitCode: 1 });
    await expect(collect(createClaudeCode(config, spawn).generate(req()))).rejects.toThrow();
    expect(existsSync(seen.systemFile)).toBe(false);
  });

  test("stdin carries one user message with the history as a transcript and the images", () => {
    const line = userInput([
      { role: "user", content: [{ type: "text", text: "A pricing page" }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
      { role: "user", content: [{ type: "text", text: "Like this" }, { type: "image", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }] },
    ]);
    expect(line.endsWith("\n")).toBe(true);
    const msg = JSON.parse(line);
    expect(msg.type).toBe("user");
    expect(msg.message.content).toEqual([
      { type: "text", text: "Conversation so far:\n\nUser: A pricing page\n\nAssistant: Done." },
      { type: "text", text: "Like this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ]);
  });

  test("tool calls on paths outside the design folder are not reported", () => {
    for (const file_path of ["/etc/passwd", `${CWD}/../other/index.html`, "../x.css"]) {
      expect(mapEvent(toolUse("Write", { file_path, content: "x" }), CWD)).toEqual([]);
    }
  });

  test("a result error fails the run", async () => {
    const { spawn } = fakeSpawn([result({ subtype: "error_during_execution", is_error: true, result: "rate limited" })]);
    await expect(collect(createClaudeCode(config, spawn).generate(req()))).rejects.toThrow("rate limited");
  });

  test("an exit without a result fails with the end of stderr", async () => {
    const { spawn } = fakeSpawn([textDelta("hi")], { exitCode: 1, stderr: "line 1\nInvalid API key · Please run /login\n" });
    await expect(collect(createClaudeCode(config, spawn).generate(req()))).rejects.toThrow(
      "Claude Code stopped without a result (exit 1): line 1 Invalid API key · Please run /login",
    );
  });

  test("abort kills the process and fails with an AbortError", async () => {
    const { spawn, seen } = fakeSpawn([textDelta("working")], { hang: true });
    const controller = new AbortController();
    const run = collect(createClaudeCode(config, spawn).generate(req({ signal: controller.signal })));
    setTimeout(() => controller.abort(), 20);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(seen.killed).toBe(true);
  });

  test("the design folder is required", async () => {
    const { spawn } = fakeSpawn([]);
    await expect(collect(createClaudeCode(config, spawn).generate(req({ cwd: undefined })))).rejects.toThrow("design folder");
  });

  test("capabilities mark the provider as editing files itself", () => {
    expect(createClaudeCode(config).capabilities.editsFiles).toBe(true);
  });
});
