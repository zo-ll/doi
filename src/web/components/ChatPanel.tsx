import { useEffect, useRef, useState } from "react";
import { chatUrl, getJSON, turnUrl, uploadUrl, type ChatEntry, type ProviderStatus } from "../api.ts";
import { isImageType, prepareImage, type PreparedImage } from "../images.ts";
import { IMAGE_LIMITS } from "../../workspace/image-limits.ts";
import { applyEvent, formatTokens, fromEntries, newAnswer, readEvents, type Answer, type ChatMessage } from "../chat.ts";
import type { Active } from "./Sidebar.tsx";
import { Icon } from "./Icon.tsx";

/** The selected element. Each frame finds it by its data-oid and draws it. */
export interface Selection {
  oid: string;
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
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
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
        if (!live) return;
        const loaded = fromEntries(entries, () => nextId.current++, (name) => uploadUrl(target.project, name));
        setMessages((list) => [...loaded, ...list]);
      })
      .catch((e: unknown) => {
        if (live) push({ kind: "error", text: `The chat history could not load: ${e instanceof Error ? e.message : String(e)}` });
      });
    return () => { live = false; };
  }, [target?.project, target?.design]);

  // Stop a running request when the panel unmounts or the design changes.
  useEffect(() => () => abortRef.current?.abort(), [target?.project, target?.design]);

  /** Adds images from the picker, a paste or a drop. Large images are scaled down here. */
  const addImages = async (files: File[]) => {
    const picked = files.filter((f) => f.type.startsWith("image/"));
    if (!picked.length) return;
    setImageError(null);
    const room = IMAGE_LIMITS.count - images.length;
    if (picked.length > room) setImageError(`At most ${IMAGE_LIMITS.count} images in one message.`);
    const added: PreparedImage[] = [];
    for (const f of picked.slice(0, Math.max(0, room))) {
      try {
        if (!isImageType(f.type)) throw new Error(`Use a PNG, JPEG, WebP or GIF image (not ${f.type}).`);
        added.push(await prepareImage(f));
      } catch (e) {
        setImageError(e instanceof Error ? e.message : String(e));
      }
    }
    setImages((list) => [...list, ...added].slice(0, IMAGE_LIMITS.count));
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || running || !target) return;
    const sent = images;
    push({
      kind: "user",
      text,
      ...(selection ? { target: selection.oid } : {}),
      ...(sent.length ? { images: sent.map((i) => i.url) } : {}),
    });
    setImages([]);
    setImageError(null);
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
        body: JSON.stringify({
          text,
          target: selection?.oid ?? null,
          images: sent.map(({ mediaType, data }) => ({ mediaType, data })),
        }),
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
                {m.images && (
                  <div className="msg-images">
                    {m.images.map((src, i) => <img key={i} src={src} alt={`Attached image ${i + 1}`} />)}
                  </div>
                )}
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
        <div
          className={`composer ${disabled ? "is-disabled" : ""} ${dragging ? "is-dragging" : ""}`}
          onDragOver={(e) => {
            if (disabled || !e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(e) => {
            if (disabled) return;
            e.preventDefault();
            setDragging(false);
            void addImages([...e.dataTransfer.files]);
          }}
        >
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
          {images.length > 0 && (
            <div className="composer-images">
              {images.map((img, i) => (
                <span key={i} className="composer-thumb">
                  <img src={img.url} alt={`Image ${i + 1} to send`} />
                  <button
                    className="chip-close"
                    aria-label={`Remove image ${i + 1}`}
                    onClick={() => setImages((list) => list.filter((_, j) => j !== i))}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {imageError && <p className="composer-image-error" role="alert">{imageError}</p>}
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
              if (files.length) {
                e.preventDefault();
                void addImages(files);
              }
            }}
            placeholder={disabled ? "Select a design to start" : "Describe a design or a change…"}
            rows={2}
            disabled={disabled}
            aria-label="Message"
          />
          <div className="composer-actions">
            <button
              className="icon-btn"
              disabled={disabled || images.length >= IMAGE_LIMITS.count}
              title="Attach images (or paste or drop them)"
              aria-label="Attach image"
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="attach" />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(e) => {
                void addImages([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
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
      {a.commitError && <p className="msg-info">The change was not saved in the version history: {a.commitError}</p>}
      {(a.files.length > 0 || a.usage) && (
        <p className="msg-meta">
          {a.files.length > 0 && <span>Changed {a.files.join(", ")}</span>}
          {a.commit && <span title={a.commit}>Saved as {a.commit.slice(0, 7)}</span>}
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
