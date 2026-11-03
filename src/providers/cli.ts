import { isAbsolute, relative, sep } from "node:path";
import type { Message } from "./types.ts";

/** Shared process helpers for CLI backends (Claude Code, Codex). */

export interface Proc {
  stdin: { write(data: string): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export type Spawn = (cmd: string[], cwd: string) => Proc;

export const bunSpawn: Spawn = (cmd, cwd) => {
  const proc = Bun.spawn(cmd, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return { stdin: proc.stdin, stdout: proc.stdout, stderr: proc.stderr, exited: proc.exited, kill: () => proc.kill() };
};

type ProcessResult = { ok: true; code: number; stderr: string } | { ok: false; error: unknown };

/** Captures stderr concurrently, but a descendant cannot hold its pipe beyond 500 ms after exit. */
export async function readProcessResult(proc: Pick<Proc, "stderr" | "exited">): Promise<ProcessResult> {
  const stop = new AbortController();
  const decoder = new TextDecoder();
  let text = "";
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stderr = proc.stderr.pipeTo(new WritableStream<Uint8Array>({
    write(chunk) { text += decoder.decode(chunk, { stream: true }); },
  }), { signal: stop.signal }).catch((error: unknown) => {
    if (!stop.signal.aborted || error !== stop.signal.reason) throw error;
  }).finally(() => { closed = true; });
  const exited = proc.exited.then((code) => {
    if (!closed) timer = setTimeout(() => stop.abort(), 500);
    return code;
  });
  try {
    const [code] = await Promise.all([exited, stderr]);
    return { ok: true, code, stderr: text + decoder.decode() };
  } catch (error) {
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
    stop.abort();
    // The result above reports read failures. Cancellation only releases the pipe.
    await stderr.catch(() => {});
  }
}

export function textOf(m: Message): string {
  return m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
}

export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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
export function insideCwd(cwd: string, file: unknown): string | null {
  if (typeof file !== "string") return null;
  const rel = isAbsolute(file) ? relative(cwd, file) : file;
  return rel === "" || rel.startsWith("..") || rel.split(sep).includes("..") || isAbsolute(rel) ? null : rel;
}

