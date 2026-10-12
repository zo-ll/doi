import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Config } from "../config.ts";
import type { ContentPart, GenerateEvent, GenerateRequest, Message, Provider } from "./types.ts";

/**
 * A Claude Pro or Max subscription, through the unmodified Claude Code CLI. Anthropic's terms
 * permit subscription sign-in only there (https://code.claude.com/docs/en/legal-and-compliance),
 * so doi starts `claude -p` and never touches the CLI's credentials.
 *
 * Claude Code edits the design files itself (`editsFiles: true`). The edit and write events
 * below only report what it changed; the edit applier does not apply them again.
 */

/**
 * Flags checked against Claude Code 2.1.296. The system text goes in a file, not in argv:
 * one argument is limited to about 128 KB on Linux, and argv is visible in the process list.
 */
export function claudeArgs(model: string, systemFile: string): string[] {
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose", // required by stream-json output
    "--include-partial-messages", // text deltas as they arrive
    "--restricted", // no code-running tools, no user/project settings, file tools confined to the cwd
    "--strict-mcp-config", // and no MCP servers
    "--tools", "Read,Edit,Write",
    "--permission-mode", "acceptEdits",
    "--no-session-persistence",
    "--model", model,
    "--append-system-prompt-file", systemFile,
  ];
}

export interface Proc {
  stdin: { write(data: string): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export type Spawn = (cmd: string[], cwd: string) => Proc;

const bunSpawn: Spawn = (cmd, cwd) => {
  const proc = Bun.spawn(cmd, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return { stdin: proc.stdin, stdout: proc.stdout, stderr: proc.stderr, exited: proc.exited, kill: () => proc.kill() };
};

function textOf(m: Message): string {
  return m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
}

/** One stream-json user message: earlier turns as a transcript, then the new message with its images. */
export function userInput(messages: Message[]): string {
  const last = messages.at(-1);
  if (!last || last.role !== "user") throw new Error("The last message must come from the user.");
  const history = messages.slice(0, -1);
  const content: object[] = [];
  if (history.length > 0) {
    const transcript = history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${textOf(m)}`).join("\n\n");
    content.push({ type: "text", text: `Conversation so far:\n\n${transcript}` });
  }
  for (const part of last.content as ContentPart[]) {
    content.push(
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image", source: { type: "base64", media_type: part.mediaType, data: Buffer.from(part.data).toString("base64") } },
    );
  }
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

/** A path from a tool call, relative to the design folder; null when it is outside. */
function insideCwd(cwd: string, file: unknown): string | null {
  if (typeof file !== "string") return null;
  const rel = isAbsolute(file) ? relative(cwd, file) : file;
  return rel === "" || rel.startsWith("..") || rel.split(sep).includes("..") || isAbsolute(rel) ? null : rel;
}

/** Maps one stream-json event to GenerateEvents. Throws on a result error. */
export function mapEvent(e: any, cwd: string): GenerateEvent[] {
  if (e.type === "stream_event" && e.event?.type === "content_block_delta" && e.event.delta?.type === "text_delta") {
    return e.event.delta.text ? [{ type: "text", delta: e.event.delta.text }] : [];
  }
  if (e.type === "assistant") {
    const out: GenerateEvent[] = [];
    for (const block of e.message?.content ?? []) {
      if (block.type !== "tool_use") continue;
      const file = insideCwd(cwd, block.input?.file_path);
      if (!file) continue;
      if (block.name === "Edit") out.push({ type: "edit", file, oldText: block.input.old_string, newText: block.input.new_string });
      if (block.name === "Write") out.push({ type: "write", file, content: block.input.content });
    }
    return out;
  }
  if (e.type === "result") {
    if (e.is_error || e.subtype !== "success") {
      throw new Error(`Claude Code failed (${e.subtype ?? "error"}): ${String(e.result ?? "").slice(0, 300)}`);
    }
    const u = e.usage ?? {};
    const cached = u.cache_read_input_tokens ?? 0;
    return [
      {
        type: "usage",
        inputTokens: (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
        cachedTokens: cached,
      },
      { type: "done" },
    ];
  }
  return [];
}

export function createClaudeCode(_config: Config, spawn: Spawn = bunSpawn): Provider {
  return {
    id: "claude-code",
    capabilities: { vision: true, toolUse: true, promptCache: "automatic", maxContextTokens: 200_000, editsFiles: true },
    async *generate(req: GenerateRequest) {
      if (!req.cwd) throw new Error("The claude-code provider needs the design folder (cwd).");
      if (req.signal?.aborted) throw new DOMException("The generation was stopped.", "AbortError");

      // A private temporary folder, not the design folder: a file there would show in the canvas and in git.
      const tmp = await mkdtemp(join(tmpdir(), "doi-claude-"));
      const systemFile = join(tmp, "system.md");
      await writeFile(systemFile, req.system.join("\n\n"), { mode: 0o600 });

      let proc: Proc;
      try {
        proc = spawn(["claude", ...claudeArgs(req.model, systemFile)], req.cwd);
      } catch (e) {
        await rm(tmp, { recursive: true, force: true });
        throw e;
      }
      const onAbort = () => proc.kill();
      req.signal?.addEventListener("abort", onAbort, { once: true });
      const stderr = new Response(proc.stderr).text();
      try {
        proc.stdin.write(userInput(req.messages));
        proc.stdin.end();

        let done = false;
        for await (const line of lines(proc.stdout)) {
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            continue; // a non-JSON line (a warning) is not part of the protocol
          }
          for (const out of mapEvent(event, req.cwd)) {
            if (out.type === "done") done = true;
            yield out;
          }
        }
        const code = await proc.exited;
        if (req.signal?.aborted) throw new DOMException("The generation was stopped.", "AbortError");
        if (!done) {
          const detail = (await stderr).trim().split("\n").slice(-3).join(" ");
          throw new Error(`Claude Code stopped without a result (exit ${code})${detail ? `: ${detail}` : ""}`);
        }
      } finally {
        req.signal?.removeEventListener("abort", onAbort);
        proc.kill(); // no-op after a normal exit; stops the process when the consumer leaves early
        await rm(tmp, { recursive: true, force: true });
      }
    },
  };
}
