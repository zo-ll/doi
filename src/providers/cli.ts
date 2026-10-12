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

