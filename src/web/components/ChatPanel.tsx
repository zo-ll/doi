import { useEffect, useRef, useState } from "react";
import { chatUrl, getJSON, turnUrl, type ChatEntry, type ProviderStatus } from "../api.ts";
import { applyEvent, formatTokens, fromEntries, newAnswer, readEvents, type Answer, type ChatMessage } from "../chat.ts";
import type { Active } from "./Sidebar.tsx";
import { Icon } from "./Icon.tsx";

export interface Selection {
  oid: string;
  rect: { x: number; y: number; width: number; height: number };
  /** The frame that reported the selection. */
  frame: string;
}

type NewMessage = ChatMessage extends infer M ? (M extends ChatMessage ? Omit<M, "id"> : never) : never;

const SUGGESTIONS = [
  "A pricing page with three plans and a FAQ",
  "A dashboard home for a fitness app",
  "Make the hero more compact",
];

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * The chat of one design. App mounts it with key = the design, so a design switch starts a
 * new panel: a run of the old design is aborted, and its messages cannot reach the new one.
 */
export function ChatPanel({ target, selection, model, modelStatus, onClearSelection }: {
  /** The open design; null disables the composer. */
  target: Active | null;
  selection: Selection | null;
  model: string | null;
  /** Status of the provider behind `model`; null while it loads. */
  modelStatus: ProviderStatus | null;
  onClearSelection: () => void;
}) {
  const disabled = target === null;
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-grow the composer up to its CSS max-height.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const push = (m: NewMessage) =>
    setMessages((list) => [...list, { ...m, id: nextId.current++ } as ChatMessage]);

  const updateAnswer = (id: number, f: (a: Answer) => Answer) =>
    setMessages((list) => list.map((m) => (m.id === id && m.kind === "assistant" ? f(m) : m)));

  // Load the stored chat. Messages sent before it arrives stay after it.
  useEffect(() => {
    if (!target) return;
    let live = true;
    getJSON<ChatEntry[]>(chatUrl(target.project, target.design))
      .then((entries) => {
        if (live) setMessages((list) => [...fromEntries(entries, () => nextId.current++), ...list]);
      })
      .catch((e: unknown) => {
        if (live) push({ kind: "error", text: `The chat history could not load: ${e instanceof Error ? e.message : String(e)}` });
      });
    return () => { live = false; };
  }, [target?.project, target?.design]);

  // Stop a running request when the panel unmounts or the design changes.
  useEffect(() => () => abortRef.current?.abort(), [target?.project, target?.design]);

  const send = async () => {
    const text = draft.trim();
    if (!text || running || !target) return;
    push({ kind: "user", text, ...(selection ? { target: selection.oid } : {}) });
    const answerId = nextId.current++;
    setMessages((list) => [...list, newAnswer(answerId)]);
    setDraft("");

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    try {
      const res = await fetch(turnUrl(target.project, target.design), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, target: selection?.oid ?? null }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const error = body?.error ?? `The request failed: ${res.status} ${res.statusText}`;
        updateAnswer(answerId, (a) => ({ ...a, status: "error", error }));
        return;
      }
      let ended = false;
      for await (const event of readEvents(res.body)) {
        if (event.type === "done" || event.type === "error") ended = true;
        updateAnswer(answerId, (a) => applyEvent(a, event));
      }
      if (!ended) {
        updateAnswer(answerId, (a) => ({ ...a, status: "error", error: "The connection closed before the turn ended." }));
      }
    } catch (e) {
      if (controller.signal.aborted) updateAnswer(answerId, (a) => ({ ...a, status: "stopped" }));
      else updateAnswer(answerId, (a) => ({ ...a, status: "error", error: `The request failed: ${e instanceof Error ? e.message : String(e)}` }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  };

  const stop = () => abortRef.current?.abort();

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      stop();
    }
  };

  const canSend = draft.trim().length > 0 && !disabled;
  const modelReady = modelStatus ? modelStatus.ready && modelStatus.implemented : false;
  const modelProblem =
    modelStatus && !modelReady
      ? !modelStatus.implemented
        ? `The ${modelStatus.id} provider is not available yet`
        : modelStatus.detail
      : null;

  return (
    <section className="chat" aria-label="Chat">
      <div className="panel-header">
        <span className="panel-title">Chat</span>
      </div>

      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-icon"><Icon name="sparkle" size={20} /></div>
            <h2>Describe a design</h2>
            <p>Write what you want, or click an element on the canvas to change only that part.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion" onClick={() => { setDraft(s); inputRef.current?.focus(); }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) =>
            m.kind === "user" ? (
              <div key={m.id} className="msg msg-user">
                {m.target && <span className="msg-target"><Icon name="target" size={12} />{m.target}</span>}
                <p>{m.text}</p>
              </div>
            ) : m.kind === "assistant" ? (
              <AnswerView key={m.id} answer={m} />
            ) : m.kind === "error" ? (
              <div key={m.id} className="notice notice-danger" role="alert">
                <Icon name="alert" />
                <p className="notice-text">{m.text}</p>
              </div>
            ) : (
              <p key={m.id} className="msg-info">{m.text}</p>
            ),
          )
        )}
        {running && (
          <div className="msg-pending" role="status">
            <span className="pending-dot" />
            Working… <span className="muted">Esc to stop</span>
          </div>
        )}
      </div>

      <div className="composer-wrap">
        {modelProblem && (
          <p className="composer-warning" role="status">
            <Icon name="alert" size={14} />
            <span>
              {modelProblem}. <span className="muted">Or change the model in config.toml.</span>
            </span>
          </p>
        )}
        <div className={`composer ${disabled ? "is-disabled" : ""}`}>
          {selection && (
            <div className="composer-context">
              <span className="chip chip-accent">
                <Icon name="target" size={12} />
                <span className="truncate">{selection.oid}</span>
                <button className="chip-close" onClick={onClearSelection} aria-label="Clear selection">
                  <Icon name="close" size={12} />
                </button>
              </span>
              <span className="muted">Edits apply to this element</span>
            </div>
          )}
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={disabled ? "Select a design to start" : "Describe a design or a change…"}
            rows={2}
            disabled={disabled}
            aria-label="Message"
          />
          <div className="composer-actions">
            <button className="icon-btn" disabled title="Image input arrives with #9" aria-label="Attach image">
              <Icon name="attach" />
            </button>
            {model && (
              <span className="composer-model truncate" title={modelStatus?.detail}>
                <span className={`status-dot ${modelStatus ? (modelReady ? "is-on" : "is-off") : ""}`} />
                {model}
              </span>
            )}
            {running ? (
              <button className="btn btn-secondary" onClick={stop} title="Stop (Esc)">
                <Icon name="stop" size={14} />
                Stop
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => void send()} disabled={!canSend} title={`Send (${isMac ? "⌘" : "Ctrl"}+Enter)`}>
                Send
                <kbd>{isMac ? "⌘" : "Ctrl"}↵</kbd>
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function AnswerView({ answer: a }: { answer: Answer }) {
  return (
    <div className="msg msg-assistant">
      {a.text && <p>{a.text}</p>}
      {a.retries > 0 && a.status === "running" && (
        <p className="msg-info">Some changes did not match. Trying again ({a.retries})…</p>
      )}
      {a.status === "error" && (
        <div className="notice notice-danger" role="alert">
          <Icon name="alert" />
          <p className="notice-text">{a.error}</p>
        </div>
      )}
      {a.status === "stopped" && <p className="msg-info">Stopped.</p>}
      {(a.files.length > 0 || a.usage) && (
        <p className="msg-meta">
          {a.files.length > 0 && <span>Changed {a.files.join(", ")}</span>}
          {a.usage && (
            <span title="Input, output and cached tokens">
              {formatTokens(a.usage.inputTokens)} in · {formatTokens(a.usage.outputTokens)} out
              {a.usage.cachedTokens > 0 && ` · ${formatTokens(a.usage.cachedTokens)} cached`}
            </span>
          )}
        </p>
      )}
    </div>
  );
}
