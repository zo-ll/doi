import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import { bunSpawn, insideCwd, lines, textOf, type Proc, type Spawn } from "./cli.ts";
import type { GenerateEvent, GenerateRequest, Message, Provider } from "./types.ts";

export type { Proc, Spawn } from "./cli.ts";

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
export function claudeArgs(model: string, systemFile: string, readDirs: string[] = []): string[] {
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
    // --restricted confines the file tools to the cwd and these folders (the linked repo's clone).
    ...readDirs.flatMap((d) => ["--add-dir", d]),
    "--model", model,
    "--append-system-prompt-file", systemFile,
  ];
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
  for (const part of last.content) {
    content.push(
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image", source: { type: "base64", media_type: part.mediaType, data: Buffer.from(part.data).toString("base64") } },
    );
  }
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

const objectSchema = z.record(z.string(), z.unknown());
const tokenCount = z.number().int().nonnegative().nullish();
const usageSchema = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cache_read_input_tokens: tokenCount,
  cache_creation_input_tokens: tokenCount,
});

/** Validates one stream-json event before it maps the event to GenerateEvents. */
export function mapEvent(raw: unknown, cwd: string): GenerateEvent[] {
  const e = objectSchema.parse(raw);
  if (e.type === "stream_event") {
    const event = objectSchema.parse(e.event);
    if (event.type !== "content_block_delta") return [];
    const delta = objectSchema.parse(event.delta);
    if (delta.type !== "text_delta") return [];
    const text = z.string().parse(delta.text);
    return text ? [{ type: "text", delta: text }] : [];
  }
  if (e.type === "assistant") {
    const out: GenerateEvent[] = [];
    const message = objectSchema.parse(e.message ?? {});
    for (const value of z.array(z.unknown()).parse(message.content ?? [])) {
      const block = objectSchema.parse(value);
      if (block.type !== "tool_use" || (block.name !== "Edit" && block.name !== "Write")) continue;
      const input = objectSchema.parse(block.input);
      const file = insideCwd(cwd, input.file_path);
      if (!file) continue;
      if (block.name === "Edit") {
        const edit = z.object({ old_string: z.string(), new_string: z.string() }).parse(input);
        out.push({ type: "edit", file, oldText: edit.old_string, newText: edit.new_string });
      } else {
        out.push({ type: "write", file, content: z.string().parse(input.content) });
      }
    }
    return out;
  }
  if (e.type === "result") {
    const result = z.object({ subtype: z.string().optional(), is_error: z.boolean().optional() }).parse(e);
    if (result.is_error || result.subtype !== "success") {
      throw new Error(`Claude Code failed (${result.subtype ?? "error"}): ${String(e.result ?? "").slice(0, 300)}`);
    }
    const u = usageSchema.parse(e.usage ?? {});
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

      const stdinText = userInput(req.messages); // a bad request starts no process

      // A private temporary folder, not the design folder: a file there would show in the canvas and in git.
      const tmp = await mkdtemp(join(tmpdir(), "doi-claude-"));
      const systemFile = join(tmp, "system.md");
      let proc: Proc;
      try {
        await writeFile(systemFile, req.system.join("\n\n"), { mode: 0o600 });
        proc = spawn(["claude", ...claudeArgs(req.model, systemFile, req.readDirs)], req.cwd);
      } catch (e) {
        await rm(tmp, { recursive: true, force: true });
        throw e;
      }
      const onAbort = () => proc.kill();
      req.signal?.addEventListener("abort", onAbort, { once: true });
      const stderr = new Response(proc.stderr).text();
      try {
        proc.stdin.write(stdinText);
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
