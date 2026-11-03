import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import { bunSpawn, insideCwd, lines, readProcessResult, textOf, type Proc, type Spawn } from "./cli.ts";
import type { GenerateEvent, GenerateRequest, Message, Provider } from "./types.ts";

/**
 * A ChatGPT subscription, through the Codex CLI signed in with `codex login`. doi starts
 * `codex exec` and never touches the CLI's credentials.
 *
 * Codex edits the design files itself (`editsFiles: true`). Its file_change items carry only
 * paths, so the adapter reads each changed file and reports it as a write; the edit applier
 * does not apply it again.
 */

/** Model name that leaves the choice to the Codex config: `codex:default`. */
export const DEFAULT_MODEL = "default";

/** Flags checked against codex-cli 0.158.0. The prompt comes on stdin ("-"). */
export function codexArgs(model: string, cwd: string, images: string[]): string[] {
  return [
    "exec",
    "--json",
    "--sandbox", "workspace-write", // writes only inside the design folder
    "--cd", cwd,
    "--skip-git-repo-check",
    "--ephemeral", // no session files
    "--ignore-user-config", // no user MCP servers or profiles; auth still comes from the Codex login
    "--ignore-rules",
    "--disable", "hooks", // the user's Codex hooks must not run inside design turns
    ...(model === DEFAULT_MODEL ? [] : ["--model", model]),
    ...images.flatMap((path) => ["--image", path]),
    "-",
  ];
}

/** Codex has no system prompt flag: the system parts lead the prompt, then the transcript, then the request. */
export function codexPrompt(system: string[], messages: Message[]): string {
  const last = messages.at(-1);
  if (!last || last.role !== "user") throw new Error("The last message must come from the user.");
  const history = messages.slice(0, -1).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${textOf(m)}`);
  return [
    `<instructions>\n${system.join("\n\n")}\n</instructions>`,
    ...(history.length ? [`<conversation>\n${history.join("\n\n")}\n</conversation>`] : []),
    `<request>\n${textOf(last)}\n</request>`,
  ].join("\n\n");
}

const objectSchema = z.record(z.string(), z.unknown());
const tokenCount = z.number().int().nonnegative().nullish();
const usageSchema = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cached_input_tokens: tokenCount,
  reasoning_output_tokens: tokenCount,
});

/** Validates one Codex JSONL event. File changes also need the file content. */
export async function mapCodexEvent(raw: unknown, cwd: string): Promise<GenerateEvent[]> {
  const e = objectSchema.parse(raw);
  if (e.type === "item.completed") {
    const item = objectSchema.parse(e.item);
    if (item.type === "agent_message") {
      const text = z.string().parse(item.text);
      return text ? [{ type: "text", delta: text.endsWith("\n") ? text : `${text}\n` }] : [];
    }
    if (item.type === "file_change" && item.status === "completed") {
      const out: GenerateEvent[] = [];
      for (const value of z.array(z.unknown()).parse(item.changes ?? [])) {
        const change = objectSchema.parse(value);
        const file = insideCwd(cwd, change.path);
        if (!file || change.kind === "delete") continue;
        const content = await Bun.file(join(cwd, file)).text().catch(() => null);
        if (content !== null) out.push({ type: "write", file, content });
      }
      return out;
    }
  }
  if (e.type === "turn.completed") {
    const u = usageSchema.parse(e.usage ?? {});
    return [
      {
        type: "usage",
        // input_tokens already includes the cached part.
        inputTokens: u.input_tokens ?? 0,
        outputTokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0),
        cachedTokens: u.cached_input_tokens ?? 0,
      },
      { type: "done" },
    ];
  }
  if (e.type === "turn.failed") {
    const error = objectSchema.parse(e.error ?? {});
    throw new Error(`Codex failed: ${String(error.message ?? "unknown error").slice(0, 300)}`);
  }
  if (e.type === "error") throw new Error(`Codex error: ${String(e.message ?? "unknown error").slice(0, 300)}`);
  return [];
}

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export function createCodex(_config: Config, spawn: Spawn = bunSpawn): Provider {
  return {
    id: "codex",
    capabilities: { vision: true, toolUse: true, promptCache: "automatic", maxContextTokens: 200_000, editsFiles: true },
    async *generate(req: GenerateRequest) {
      if (!req.cwd) throw new Error("The codex provider needs the design folder (cwd).");
      if (req.signal?.aborted) throw new DOMException("The generation was stopped.", "AbortError");

      // Images go to a private temporary folder outside the design folder.
      const tmp = await mkdtemp(join(tmpdir(), "doi-codex-"));
      let proc: Proc;
      let stdinText: string;
      try {
        const images: string[] = [];
        for (const [i, part] of (req.messages.at(-1)?.content ?? []).entries()) {
          if (part.type !== "image") continue;
          const path = join(tmp, `image-${i}.${EXTENSIONS[part.mediaType] ?? "png"}`);
          await writeFile(path, part.data, { mode: 0o600 });
          images.push(path);
        }
        stdinText = codexPrompt(req.system, req.messages); // before spawn: a bad request starts no process
        proc = spawn(["codex", ...codexArgs(req.model, req.cwd, images)], req.cwd);
      } catch (e) {
        await rm(tmp, { recursive: true, force: true });
        throw e;
      }

      const onAbort = () => proc.kill();
      req.signal?.addEventListener("abort", onAbort, { once: true });
      const completion = readProcessResult(proc);
      try {
        // Inside the main try: if the write fails, the finally still kills the process.
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
          for (const out of await mapCodexEvent(event, req.cwd)) {
            if (out.type === "done") done = true;
            yield out;
          }
        }
        const result = await completion;
        if (req.signal?.aborted) throw new DOMException("The generation was stopped.", "AbortError");
        if (!result.ok) throw new Error("Could not read the CLI result.", { cause: result.error });
        if (!done) {
          const detail = result.stderr.trim().split("\n").slice(-3).join(" ");
          throw new Error(`Codex stopped without a result (exit ${result.code})${detail ? `: ${detail}` : ""}`);
        }
      } finally {
        req.signal?.removeEventListener("abort", onAbort);
        proc.kill(); // no-op after a normal exit; stops the process when the consumer leaves early
        await completion;
        await rm(tmp, { recursive: true, force: true });
      }
    },
  };
}
