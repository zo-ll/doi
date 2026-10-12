import { appendFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderId } from "../config.ts";
import type { Message } from "../providers/types.ts";
import { withFileLock } from "./file-lock.ts";
import { assertName } from "./paths.ts";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** A comment sent with a turn (#17), as the model saw it. */
export interface TurnComment {
  id: string;
  oid: string;
  text: string;
}

/** One line of chat.jsonl. A turn has a user line and, when it ends, an assistant line. */
export type ChatEntry =
  | {
      role: "user";
      turn: string;
      design: string;
      at: string;
      text: string;
      target: string | null;
      /** File names in the project's uploads folder. */
      images?: string[];
      /** Comments the turn applied. */
      comments?: TurnComment[];
    }
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
      /** Ids of the comments this turn marked done. */
      commentsDone?: string[];
      /** The variant the user picked, when the answer came from a variants run. */
      variant?: number;
      /** The system prompt version, so a design's history names the prompt that made it. */
      prompt: string;
    };

export function chatFile(workspace: string, project: string): string {
  assertName("project", project);
  return join(workspace, "projects", project, "chat.jsonl");
}

// One write at a time for each chat file: a design rename rewrites the whole file, and an
// append from a turn on another design must not land between its read and its replace.
const withChatLock = withFileLock;

export async function appendChat(workspace: string, project: string, entry: ChatEntry): Promise<void> {
  const path = chatFile(workspace, project);
  await withChatLock(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + "\n");
  });
}

/**
 * A line that links a turn to its commit, so the version history can name the model of each
 * version. `readChat` skips it: it is not a message.
 */
export interface CommitLine {
  role: "commit";
  turn: string;
  design: string;
  at: string;
  sha: string;
}

export async function appendCommit(workspace: string, project: string, line: Omit<CommitLine, "role" | "at">): Promise<void> {
  const path = chatFile(workspace, project);
  const entry: CommitLine = { role: "commit", ...line, at: new Date().toISOString() };
  await withChatLock(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + "\n");
  });
}

/** For each commit of a turn: the provider and model that made it, as "<provider>:<model>". */
export async function commitModels(workspace: string, project: string): Promise<Map<string, string>> {
  const file = Bun.file(chatFile(workspace, project));
  const out = new Map<string, string>();
  if (!(await file.exists())) return out;
  const models = new Map<string, string>(); // turn → model
  const commits: CommitLine[] = [];
  for (const line of (await file.text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.role === "assistant" && typeof e.turn === "string") models.set(e.turn, `${e.provider}:${e.model}`);
      if (e.role === "commit" && typeof e.sha === "string") commits.push(e);
    } catch {
      // A bad line does not hide the others.
    }
  }
  for (const c of commits) {
    const m = models.get(c.turn);
    if (m) out.set(c.sha, m);
  }
  return out;
}

/** Renames a design in the project's chat. The file is replaced whole, so a crash cannot leave half of it. */
export async function renameInChat(workspace: string, project: string, from: string, to: string): Promise<void> {
  const path = chatFile(workspace, project);
  await withChatLock(path, async () => {
    const file = Bun.file(path);
    if (!(await file.exists())) return;
    const lines = (await file.text()).split("\n").map((line) => {
      if (!line.trim()) return line;
      try {
        const entry = JSON.parse(line);
        return entry.design === from ? JSON.stringify({ ...entry, design: to }) : line;
      } catch {
        return line; // keep a bad line as it is
      }
    });
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    await Bun.write(tmp, lines.join("\n"));
    await rename(tmp, path);
  });
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

/**
 * The user message as the model sees it: the comments to apply, then the text with its target.
 * The history uses the same form, so the model sees one format.
 */
export function userText(text: string, target: string | null, comments: TurnComment[] = []): string {
  const parts: string[] = [];
  if (comments.length) {
    parts.push(
      "Apply these comments. Each names one element by its data-oid. Change only these elements and " +
        "the CSS rules for them, with small edits.\n" +
        comments.map((c, i) => `${i + 1}. data-oid="${c.oid}": ${c.text}`).join("\n"),
    );
  }
  if (text.trim()) {
    parts.push(
      target
        ? `Target: data-oid="${target}". Change only this element and the CSS rules for it, with small edits. ${text}`
        : text,
    );
  }
  return parts.join("\n\n");
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
    // Old images stay out of the history: each one costs about 1600 tokens on every turn.
    const note = user.images?.length ? `\n\n(${user.images.length} image${user.images.length > 1 ? "s" : ""} attached to this message.)` : "";
    out.push({ role: "user", content: [{ type: "text", text: userText(user.text, user.target, user.comments) + note }] });
    // Only the answer text: a note such as "(Changed files: …)" here was copied by the model
    // into its next answers. The current files are in the context anyway.
    out.push({ role: "assistant", content: [{ type: "text", text: e.text.trim() || "Done." }] });
  }
  return out;
}
