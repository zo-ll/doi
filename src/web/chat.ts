import type { ChatEntry, TurnStreamEvent, Usage, VariantStreamEvent } from "./api.ts";

export type AnswerStatus = "running" | "done" | "error" | "stopped";

export type ChatMessage =
  | {
      id: number;
      kind: "user";
      text: string;
      target?: string;
      images?: string[];
      /** Comments the turn applied: element and text. */
      comments?: { oid: string; text: string }[];
    }
  | {
      id: number;
      kind: "assistant";
      text: string;
      status: AnswerStatus;
      files: string[];
      usage: Usage | null;
      retries: number;
      error?: string;
      /** The commit of the turn; commitError when it failed (the turn itself succeeded). */
      commit?: string;
      commitError?: string;
      /** How many of the turn's comments are done now. */
      commentsDone?: number;
    }
  | VariantsMessage
  | { id: number; kind: "error"; text: string }
  | { id: number; kind: "info"; text: string };

export type Answer = Extract<ChatMessage, { kind: "assistant" }>;

/** One variant while it runs, as the chat shows it. */
export interface VariantItem {
  n: number;
  model: string;
  status: "running" | "done" | "error" | "stopped";
  text: string;
  usage: Usage | null;
  error?: string;
}

/** The answer of a variants run: one item per variant. It is not stored; the pick is. */
export interface VariantsMessage {
  id: number;
  kind: "variants";
  status: "running" | "done" | "error" | "stopped";
  items: VariantItem[];
  error?: string;
}

/** Applies one event of a variants stream. */
export function applyVariantEvent(m: VariantsMessage, e: VariantStreamEvent): VariantsMessage {
  switch (e.type) {
    case "variants":
      return {
        ...m,
        items: e.variants.map((v) => ({ n: v.n, model: `${v.provider}:${v.model}`, status: "running", text: "", usage: null })),
      };
    case "variants-done":
      return { ...m, status: m.items.some((i) => i.status === "done") ? "done" : "error", ...(e.error ? { error: e.error } : {}) };
    case "variant":
      return {
        ...m,
        items: m.items.map((item) => {
          if (item.n !== e.n) return item;
          const ev = e.event;
          switch (ev.type) {
            case "text":
              return { ...item, text: item.text + ev.delta };
            case "retry":
              return { ...item, text: "" };
            case "usage": {
              const u = item.usage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
              return {
                ...item,
                usage: { inputTokens: u.inputTokens + ev.inputTokens, outputTokens: u.outputTokens + ev.outputTokens, cachedTokens: u.cachedTokens + ev.cachedTokens },
              };
            }
            case "done":
              return { ...item, status: "done" };
            case "error":
              return { ...item, status: "error", error: errorText(ev.kind, ev.message) };
            default:
              return item;
          }
        }),
      };
  }
}

export function newAnswer(id: number): Answer {
  return { id, kind: "assistant", text: "", status: "running", files: [], usage: null, retries: 0 };
}

/** The stored chat as panel messages. A user line without an answer is a turn that never ended. */
export function fromEntries(entries: ChatEntry[], nextId: () => number, imageUrl: (name: string) => string = (n) => n): ChatMessage[] {
  const answered = new Set(entries.filter((e) => e.role === "assistant").map((e) => e.turn));
  const out: ChatMessage[] = [];
  for (const e of entries) {
    if (e.role === "user") {
      out.push({
        id: nextId(),
        kind: "user",
        text: e.text,
        ...(e.target ? { target: e.target } : {}),
        ...(e.images?.length ? { images: e.images.map(imageUrl) } : {}),
        ...(e.comments?.length ? { comments: e.comments.map(({ oid, text }) => ({ oid, text })) } : {}),
      });
      if (!answered.has(e.turn)) out.push({ id: nextId(), kind: "info", text: "This turn did not finish." });
    } else {
      out.push({
        id: nextId(),
        kind: "assistant",
        text: e.text,
        status: e.status,
        files: e.files,
        usage: e.usage,
        retries: 0,
        ...(e.error ? { error: e.error } : {}),
        ...(e.commentsDone?.length ? { commentsDone: e.commentsDone.length } : {}),
      });
    }
  }
  return out;
}

const addFile = (files: string[], file: string) => (files.includes(file) ? files : [...files, file]);

/** Applies one stream event to the answer. */
export function applyEvent(a: Answer, e: TurnStreamEvent): Answer {
  switch (e.type) {
    case "text":
      return { ...a, text: a.text + e.delta };
    case "retry":
      // The changes failed and the model answers again; its first text no longer applies.
      return { ...a, text: "", retries: a.retries + 1 };
    case "edit":
    case "write":
      // Proposed or reported changes; "applied" lists the files that really changed.
      return a;
    case "applied":
      return { ...a, files: e.files.reduce(addFile, a.files) };
    case "usage": {
      const u = a.usage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
      return {
        ...a,
        usage: {
          inputTokens: u.inputTokens + e.inputTokens,
          outputTokens: u.outputTokens + e.outputTokens,
          cachedTokens: u.cachedTokens + e.cachedTokens,
        },
      };
    }
    case "done":
      return { ...a, status: "done" };
    case "error":
      return { ...a, status: "error", error: errorText(e.kind, e.message) };
    case "commit":
      return e.sha ? { ...a, commit: e.sha } : e.error ? { ...a, commitError: e.error } : a;
    case "comments":
      return { ...a, commentsDone: e.done.length };
  }
}

export function errorText(kind: "context" | "apply" | "provider", message: string): string {
  if (kind === "apply") return `The changes could not be applied, so the design is unchanged. ${message}`;
  return message;
}

/** Reads server-sent events and yields the JSON of each data line. */
export async function* readEvents<T = TurnStreamEvent>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data) as T;
    }
    if (done) return;
  }
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}
