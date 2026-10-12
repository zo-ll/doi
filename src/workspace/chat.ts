import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderId } from "../config.ts";
import type { Message } from "../providers/types.ts";
import { assertName } from "./paths.ts";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** One line of chat.jsonl. A turn has a user line and, when it ends, an assistant line. */
export type ChatEntry =
  | { role: "user"; turn: string; design: string; at: string; text: string; target: string | null }
  | {
      role: "assistant";
      turn: string;
      design: string;
      at: string;
      text: string;
      status: "done" | "error" | "stopped";
      provider: ProviderId;
      model: string;
      usage: Usage;
      /** Files the turn changed. */
      files: string[];
      error?: string;
      /** The system prompt version, so a design's history names the prompt that made it. */
      prompt: string;
    };

export function chatFile(workspace: string, project: string): string {
  assertName("project", project);
  return join(workspace, "projects", project, "chat.jsonl");
}

export async function appendChat(workspace: string, project: string, entry: ChatEntry): Promise<void> {
  const path = chatFile(workspace, project);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + "\n");
}

/** The entries of one design, oldest first. A bad line (a crash during a write) is skipped. */
export async function readChat(workspace: string, project: string, design: string): Promise<ChatEntry[]> {
  assertName("design", design);
  const file = Bun.file(chatFile(workspace, project));
  if (!(await file.exists())) return [];
  const out: ChatEntry[] = [];
  for (const line of (await file.text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ChatEntry;
      if (entry.design === design && (entry.role === "user" || entry.role === "assistant")) out.push(entry);
    } catch {
      // Skip it; one bad line must not hide the rest of the chat.
    }
  }
  return out;
}

/** Same form as the new message in the context, so the model sees one format. */
export function userText(text: string, target: string | null): string {
  return target ? `Target: data-oid="${target}". ${text}` : text;
}

/**
 * The history for the model: only turns that completed, as user and assistant pairs.
 * Failed and stopped turns changed no files, so the model does not need them.
 */
export function historyMessages(entries: ChatEntry[]): Message[] {
  const users = new Map<string, Extract<ChatEntry, { role: "user" }>>();
  const out: Message[] = [];
  for (const e of entries) {
    if (e.role === "user") {
      users.set(e.turn, e);
      continue;
    }
    const user = users.get(e.turn);
    if (!user || e.status !== "done") continue;
    const changed = e.files.length ? `\n\n(Changed files: ${e.files.join(", ")})` : "";
    out.push({ role: "user", content: [{ type: "text", text: userText(user.text, user.target) }] });
    out.push({ role: "assistant", content: [{ type: "text", text: `${e.text.trim() || "Done."}${changed}` }] });
  }
  return out;
}
