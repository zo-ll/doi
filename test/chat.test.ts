import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendChat, chatFile, historyMessages, readChat, type ChatEntry } from "../src/workspace/chat.ts";
import { applyEvent, fromEntries, newAnswer, readEvents } from "../src/web/chat.ts";

const at = "2026-10-12T00:00:00.000Z";
const usage = { inputTokens: 100, outputTokens: 20, cachedTokens: 80 };
const user = (turn: string, text: string, design = "home", target: string | null = null): ChatEntry => ({ role: "user", turn, design, at, text, target });
const answer = (turn: string, text: string, status: "done" | "error" | "stopped" = "done", files: string[] = ["styles.css"]): ChatEntry => ({
  role: "assistant", turn, design: "home", at, text, status, provider: "anthropic", model: "m", usage, files, prompt: "v0",
});

describe("chat store", () => {
  test("appends lines and reads only the asked design, skipping bad lines", async () => {
    const ws = await mkdtemp(join(tmpdir(), "doi-chat-"));
    await appendChat(ws, "p", user("t1", "hello"));
    await appendChat(ws, "p", user("t2", "other design", "about"));
    await appendFile(chatFile(ws, "p"), "{broken\n");
    await appendChat(ws, "p", answer("t1", "hi"));
    expect(await readChat(ws, "p", "home")).toEqual([user("t1", "hello"), answer("t1", "hi")]);
    expect(await readChat(ws, "p", "about")).toEqual([user("t2", "other design", "about")]);
    expect(await readChat(ws, "p", "none")).toEqual([]);
    expect(await readChat(ws, "q", "home")).toEqual([]);
    await expect(readChat(ws, "../p", "home")).rejects.toThrow("Invalid project");
  });

  test("history has only completed turns, as user and assistant pairs", () => {
    const entries = [
      user("t1", "make a page"),
      answer("t1", "Made it."),
      user("t2", "bigger", "home", "title"),
      answer("t2", "", "done", []),
      user("t3", "fails"),
      answer("t3", "", "error"),
      user("t4", "stopped"),
      answer("t4", "partial", "stopped"),
      user("t5", "never answered"),
    ];
    const texts = historyMessages(entries).map((m) => `${m.role}: ${(m.content[0] as { text: string }).text}`);
    expect(texts).toEqual([
      "user: make a page",
      "assistant: Made it.",
      'user: Target: data-oid="title". Change only this element and the CSS rules for it, with small edits. bigger',
      "assistant: Done.",
    ]);
  });
});

describe("chat panel logic", () => {
  test("stored entries become panel messages, with a note for an unfinished turn", () => {
    let id = 0;
    const msgs = fromEntries([user("t1", "a", "home", "cta"), answer("t1", "b", "error"), user("t2", "c")], () => ++id);
    expect(msgs.map((m) => m.kind)).toEqual(["user", "assistant", "user", "info"]);
    expect(msgs[0]).toMatchObject({ target: "cta" });
    expect(msgs[1]).toMatchObject({ status: "error", text: "b", usage });
  });

  test("answers carry time, model, task and line counts", () => {
    let id = 0;
    const stats = [{ file: "styles.css", add: 6, del: 2 }];
    const msgs = fromEntries(
      [
        user("t1", "a page"),
        { ...answer("t1", "made"), stats },
        user("t2", "bigger", "home", "title"),
        answer("t2", "done"),
        user("t3", "variants"),
        { ...answer("t3", "picked"), variant: 2 } as ChatEntry,
      ],
      () => ++id,
    );
    expect(msgs[0]).toMatchObject({ kind: "user", at });
    expect(msgs[1]).toMatchObject({ at, model: "m", task: "generate", stats });
    expect(msgs[3]).toMatchObject({ task: "edit" });
    expect(msgs[3]).not.toHaveProperty("stats");
    expect(msgs[5]).toMatchObject({ task: "variant 2" });
    const live = applyEvent(newAnswer(9, "small", "edit"), { type: "commit", sha: "abc1234", stats });
    expect(live).toMatchObject({ model: "small", task: "edit", commit: "abc1234", stats });
  });

  test("stream events build the answer", () => {
    let a = newAnswer(1);
    for (const e of [
      { type: "text", delta: "Try " },
      { type: "retry", attempt: 1, failures: [] },
      { type: "text", delta: "Done." },
      { type: "usage", inputTokens: 10, outputTokens: 2, cachedTokens: 0 },
      { type: "usage", inputTokens: 20, outputTokens: 3, cachedTokens: 5 },
      { type: "applied", files: ["index.html", "styles.css"] },
      { type: "done" },
    ] as const) {
      a = applyEvent(a, e as any);
    }
    expect(a).toMatchObject({ text: "Done.", retries: 1, status: "done", files: ["index.html", "styles.css"] });
    expect(a.usage).toEqual({ inputTokens: 30, outputTokens: 5, cachedTokens: 5 });

    const failed = applyEvent(newAnswer(2), { type: "error", kind: "apply", message: "x" });
    expect(failed).toMatchObject({ status: "error", error: expect.stringContaining("design is unchanged") });
  });

  test("readEvents parses events split across chunks", async () => {
    const text = 'event: text\ndata: {"type":"text","delta":"héllo"}\n\nevent: done\ndata: {"type":"done"}\n\n';
    const bytes = new TextEncoder().encode(text);
    // Split inside the multi-byte "é" and inside the separator.
    const cuts = [0, 30, 33, 52, 53, bytes.length];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 1; i < cuts.length; i++) c.enqueue(bytes.slice(cuts[i - 1], cuts[i]));
        c.close();
      },
    });
    const out = [];
    for await (const e of readEvents(stream)) out.push(e);
    expect(out).toEqual([{ type: "text", delta: "héllo" }, { type: "done" }]);
  });
});
