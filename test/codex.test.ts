import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import type { Proc, Spawn } from "../src/providers/cli.ts";
import { codexArgs, codexPrompt, createCodex, mapCodexEvent } from "../src/providers/codex.ts";
import type { GenerateEvent, GenerateRequest } from "../src/providers/types.ts";

const config = parseConfig({}, "/tmp/doi");
const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function designDir() {
  const dir = await mkdtemp(join(tmpdir(), "doi-codex-test-"));
  dirs.push(dir);
  await Bun.write(join(dir, "styles.css"), "body { color: blue; }\n");
  return dir;
}

const message = (text: string) => ({ type: "item.completed", item: { id: "i", type: "agent_message", text } });
const fileChange = (changes: object[]) => ({ type: "item.completed", item: { id: "f", type: "file_change", changes, status: "completed" } });
const turnCompleted = {
  type: "turn.completed",
  usage: { input_tokens: 74431, cached_input_tokens: 48000, cache_write_input_tokens: 0, output_tokens: 239, reasoning_output_tokens: 9 },
};

/** A fake `codex` process: replays JSONL `events` and records what doi sent. */
function fakeSpawn(events: object[], opts: { exitCode?: number; stderr?: string; hang?: boolean } = {}) {
  const seen = { cmd: [] as string[], cwd: "", stdin: "", killed: false, images: [] as string[] };
  const spawn: Spawn = (cmd, cwd) => {
    seen.cmd = cmd;
    seen.cwd = cwd;
    seen.images = cmd.flatMap((a, i) => (cmd[i - 1] === "--image" ? [a] : []));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const proc: Proc = {
      stdin: { write: (d: string) => (seen.stdin += d), end: () => {} },
      stdout: new ReadableStream<Uint8Array>({
        async start(c) {
          for (const e of events) c.enqueue(new TextEncoder().encode(JSON.stringify(e) + "\n"));
          if (opts.hang) await gate;
          c.close();
        },
      }),
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

const req = (cwd: string, over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  model: "default",
  system: ["design rules", "current files"],
  messages: [{ role: "user", content: [{ type: "text", text: "Make the text blue" }] }],
  cwd,
  ...over,
});

async function collect(gen: AsyncIterable<GenerateEvent>) {
  const out: GenerateEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("codex provider", () => {
  test("runs codex exec in the design folder and maps the events", async () => {
    const cwd = await designDir();
    const { spawn, seen } = fakeSpawn([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      message("I will change the color."),
      { type: "item.completed", item: { id: "c", type: "command_execution", command: "cat styles.css", exit_code: 0 } },
      fileChange([{ path: join(cwd, "styles.css"), kind: "update" }]),
      message("done"),
      turnCompleted,
    ]);
    const events = await collect(createCodex(config, spawn).generate(req(cwd)));

    expect(seen.cmd[0]).toBe("codex");
    expect(seen.cwd).toBe(cwd);
    expect(events).toEqual([
      { type: "text", delta: "I will change the color.\n" },
      { type: "write", file: "styles.css", content: "body { color: blue; }\n" },
      { type: "text", delta: "done\n" },
      { type: "usage", inputTokens: 74431, outputTokens: 248, cachedTokens: 48000 },
      { type: "done" },
    ]);
  });

  test("the command is sandboxed to the design folder and skips user config, rules and hooks", () => {
    const args = codexArgs("default", "/ws/home", []);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(args[0]).toBe("exec");
    expect(flag("--sandbox")).toBe("workspace-write");
    expect(flag("--cd")).toBe("/ws/home");
    expect(flag("--disable")).toBe("hooks");
    for (const f of ["--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"]) {
      expect(args).toContain(f);
    }
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--model"); // "default" leaves the model to Codex
    expect(args.at(-1)).toBe("-"); // prompt on stdin
    expect(codexArgs("gpt-6-luna", "/ws", []).join(" ")).toContain("--model gpt-6-luna");
  });

  test("the prompt carries the system parts, the transcript and the request", () => {
    const prompt = codexPrompt(
      ["rules", "files"],
      [
        { role: "user", content: [{ type: "text", text: "A pricing page" }] },
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
        { role: "user", content: [{ type: "text", text: "Now in green" }] },
      ],
    );
    expect(prompt).toBe(
      "<instructions>\nrules\n\nfiles\n</instructions>\n\n" +
        "<conversation>\nUser: A pricing page\n\nAssistant: Done.\n</conversation>\n\n" +
        "<request>\nNow in green\n</request>",
    );
  });

  test("images go to a private folder outside the design folder, removed after the run", async () => {
    const cwd = await designDir();
    const { spawn, seen } = fakeSpawn([turnCompleted]);
    await collect(
      createCodex(config, spawn).generate(
        req(cwd, {
          messages: [{ role: "user", content: [{ type: "text", text: "like this" }, { type: "image", mediaType: "image/png", data: new Uint8Array([1, 2]) }] }],
        }),
      ),
    );
    expect(seen.images).toHaveLength(1);
    expect(seen.images[0]!.startsWith(cwd)).toBe(false);
    expect(seen.images[0]!.endsWith(".png")).toBe(true);
    expect(existsSync(seen.images[0]!)).toBe(false);
  });

  test("file changes outside the design folder and deletions are not reported", async () => {
    const cwd = await designDir();
    const out = await mapCodexEvent(
      fileChange([
        { path: "/etc/hosts", kind: "update" },
        { path: join(cwd, "..", "other.css"), kind: "add" },
        { path: join(cwd, "styles.css"), kind: "delete" },
      ]),
      cwd,
    );
    expect(out).toEqual([]);
  });

  test("turn.failed and error events fail the run", async () => {
    const cwd = await designDir();
    for (const event of [{ type: "turn.failed", error: { message: "usage limit reached" } }, { type: "error", message: "usage limit reached" }]) {
      const { spawn } = fakeSpawn([event]);
      await expect(collect(createCodex(config, spawn).generate(req(cwd)))).rejects.toThrow("usage limit reached");
    }
  });

  test("an exit without a result fails with the end of stderr", async () => {
    const cwd = await designDir();
    const { spawn } = fakeSpawn([message("hi")], { exitCode: 1, stderr: "Not logged in\n" });
    await expect(collect(createCodex(config, spawn).generate(req(cwd)))).rejects.toThrow(
      "Codex stopped without a result (exit 1): Not logged in",
    );
  });

  test("abort kills the process and fails with an AbortError", async () => {
    const cwd = await designDir();
    const { spawn, seen } = fakeSpawn([message("working")], { hang: true });
    const controller = new AbortController();
    const run = collect(createCodex(config, spawn).generate(req(cwd, { signal: controller.signal })));
    setTimeout(() => controller.abort(), 20);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(seen.killed).toBe(true);
  });

  test("the design folder is required, and the provider edits files itself", async () => {
    const { spawn } = fakeSpawn([]);
    await expect(collect(createCodex(config, spawn).generate(req("", { cwd: undefined })))).rejects.toThrow("design folder");
    expect(createCodex(config).capabilities.editsFiles).toBe(true);
  });
});
