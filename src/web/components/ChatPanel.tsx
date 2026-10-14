import { useEffect, useRef, useState } from "react";
import { chatUrl, getJSON, turnUrl, uploadUrl, variantsUrl, type ChatEntry, type ProviderStatus, type VariantStreamEvent } from "../api.ts";
import { isImageType, prepareImage, type PreparedImage } from "../images.ts";
import { IMAGE_LIMITS } from "../../workspace/image-limits.ts";
import {
  applyEvent,
  applyVariantEvent,
  formatTokens,
  fromEntries,
  newAnswer,
  readEvents,
  type Answer,
  type ChatMessage,
  type VariantsMessage,
} from "../chat.ts";
import type { Active } from "../api.ts";
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
/** Comments to apply in one turn, from the Comments tab. `key` makes each request new. */
export interface CommentRequest {
  key: number;
  comments: { id: string; oid: string; text: string }[];
}

export function ChatPanel({
  target,
  selection,
  model,
  modelStatus,
  onClearSelection,
  hidden = false,
  request = null,
  onRequestTaken,
  onRunningChange,
  onCommentsChanged,
  modelRef = null,
  models = [],
  variantsOpen = false,
  onVariantsChanged,
}: {
  /** The open design; null disables the composer. */
  target: Active | null;
  selection: Selection | null;
  model: string | null;
  /** Status of the provider behind `model`; null while it loads. */
  modelStatus: ProviderStatus | null;
  onClearSelection: () => void;
  /** The panel stays mounted behind another tab, so a running turn goes on. */
  hidden?: boolean;
  request?: CommentRequest | null;
  onRequestTaken?: () => void;
  onRunningChange?: (running: boolean) => void;
  /** A turn marked comments done. */
  onCommentsChanged?: () => void;
  /** The default model as "<provider>:<model>", for variants. */
  modelRef?: string | null;
  /** The models from config.toml, offered for each variant. */
  models?: string[];
  /** The design has open variants: no turn can start until one is picked or they are discarded. */
  variantsOpen?: boolean;
  /** A variants run changed the open set. */
  onVariantsChanged?: () => void;
}) {
  const disabled = target === null;
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  // 1 is a normal turn; 2 to 4 starts that many variants.
  const [count, setCount] = useState(1);
  const [variantModels, setVariantModels] = useState<string[]>([]);
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
  const updateVariants = (id: number, f: (m: VariantsMessage) => VariantsMessage) =>
    setMessages((list) => list.map((m) => (m.id === id && m.kind === "variants" ? f(m) : m)));

  /** The model of each variant: the chosen one, or the default. */
  const modelsFor = (n: number) => Array.from({ length: n }, (_, i) => variantModels[i]?.trim() || modelRef || "");

  /** Starts `count` variants of the draft. The answer streams into one message. */
  const sendVariants = async () => {
    const text = draft.trim();
    if (!text || running || !target) return;
    const turnTarget = selection?.oid ?? null;
    push({ kind: "user", text, ...(turnTarget ? { target: turnTarget } : {}) });
    const id = nextId.current++;
    setMessages((list) => [...list, { id, kind: "variants", status: "running", items: [] }]);
    setDraft("");
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    try {
      const res = await fetch(variantsUrl(target.project, target.design), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, target: turnTarget, count, models: modelsFor(count) }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        updateVariants(id, (m) => ({ ...m, status: "error", error: body?.error ?? `The request failed: ${res.status} ${res.statusText}` }));
        return;
      }
      let ended = false;
      for await (const event of readEvents<VariantStreamEvent>(res.body)) {
        updateVariants(id, (m) => applyVariantEvent(m, event));
        if (event.type === "variants" || event.type === "variants-done") onVariantsChanged?.();
        if (event.type === "variant" && (event.event.type === "done" || event.event.type === "error")) onVariantsChanged?.();
        if (event.type === "variants-done") ended = true;
      }
      if (!ended) updateVariants(id, (m) => ({ ...m, status: "error", error: "The connection closed before the variants ended." }));
    } catch (e) {
      if (controller.signal.aborted) updateVariants(id, (m) => ({ ...m, status: "stopped" }));
      else updateVariants(id, (m) => ({ ...m, status: "error", error: `The request failed: ${e instanceof Error ? e.message : String(e)}` }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
      onVariantsChanged?.();
    }
  };

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

  /** Sends the draft, or with `comments` only those comments; the draft and images stay then. */
  const send = async (comments?: CommentRequest["comments"]) => {
    const text = comments ? "" : draft.trim();
    if ((!text && !comments?.length) || running || !target) return;
    const sent = comments ? [] : images;
    const turnTarget = comments ? null : (selection?.oid ?? null);
    push({
      kind: "user",
      text,
      ...(turnTarget ? { target: turnTarget } : {}),
      ...(sent.length ? { images: sent.map((i) => i.url) } : {}),
      ...(comments ? { comments: comments.map(({ oid, text }) => ({ oid, text })) } : {}),
    });
    if (!comments) {
      setImages([]);
      setImageError(null);
      setDraft("");
    }
    const answerId = nextId.current++;
    setMessages((list) => [...list, newAnswer(answerId)]);

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    try {
      const res = await fetch(turnUrl(target.project, target.design), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          target: turnTarget,
          images: sent.map(({ mediaType, data }) => ({ mediaType, data })),
          ...(comments ? { comments: comments.map((c) => c.id) } : {}),
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
        if (event.type === "comments") onCommentsChanged?.();
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

  useEffect(() => onRunningChange?.(running), [running]);

  // "Apply" in the Comments tab: run one turn for those comments.
  useEffect(() => {
    if (!request || running || !target) return;
    onRequestTaken?.();
    void send(request.comments);
  }, [request, running]);

  const submit = () => void (count > 1 ? sendVariants() : send());

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canSend) submit();
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      stop();
    }
  };

  // Variants take text only; images go with a normal turn.
  const variantsWithImages = count > 1 && images.length > 0;
  const canSend = draft.trim().length > 0 && !disabled && !variantsOpen && !variantsWithImages;
  const modelReady = modelStatus ? modelStatus.ready && modelStatus.implemented : false;
  const modelProblem =
    modelStatus && !modelReady
      ? !modelStatus.implemented
        ? `The ${modelStatus.id} provider is not available yet`
        : modelStatus.detail
      : null;

  return (
    <section className="chat" aria-label="Chat" hidden={hidden}>

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
                {m.comments && (
                  <ol className="msg-comments" aria-label="Comments to apply">
                    {m.comments.map((c, i) => (
                      <li key={i}>
                        <span className="msg-target"><Icon name="target" size={12} />{c.oid}</span> {c.text}
                      </li>
                    ))}
                  </ol>
                )}
                {m.text && <p>{m.text}</p>}
              </div>
            ) : m.kind === "assistant" ? (
              <AnswerView key={m.id} answer={m} />
            ) : m.kind === "error" ? (
              <div key={m.id} className="notice notice-danger" role="alert">
                <Icon name="alert" />
                <p className="notice-text">{m.text}</p>
              </div>
            ) : m.kind === "variants" ? (
              <VariantsView key={m.id} message={m} />
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
        {variantsOpen && (
          <p className="composer-warning" role="status">
            <Icon name="alert" size={14} />
            <span>This design has variants. Pick one on the canvas, or discard them, before the next change.</span>
          </p>
        )}
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
          {variantsWithImages && <p className="composer-image-error" role="alert">Variants do not take images. Remove the images, or make one design.</p>}
          {count > 1 && (
            <div className="variant-models">
              {Array.from({ length: count }, (_, i) => (
                <label key={i} className="variant-model">
                  <span className="muted">{i + 1}</span>
                  <input
                    list="doi-models"
                    value={variantModels[i] ?? modelRef ?? ""}
                    onChange={(e) => setVariantModels((list) => Object.assign([...list], { [i]: e.target.value }))}
                    aria-label={`Model of variant ${i + 1}`}
                    placeholder="provider:model"
                    spellCheck={false}
                  />
                </label>
              ))}
              <datalist id="doi-models">
                {models.map((m) => <option key={m} value={m} />)}
              </datalist>
            </div>
          )}
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
            <select
              className="variant-count"
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              aria-label="Number of variants"
              title="Make one design, or 2 to 4 variants to compare"
              disabled={disabled || running}
            >
              <option value={1}>1×</option>
              <option value={2}>2×</option>
              <option value={3}>3×</option>
              <option value={4}>4×</option>
            </select>
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
              <button className="btn btn-primary" onClick={submit} disabled={!canSend} title={`Send (${isMac ? "⌘" : "Ctrl"}+Enter)`}>
                {count > 1 ? `Make ${count}` : "Send"}
                <kbd>{isMac ? "⌘" : "Ctrl"}↵</kbd>
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function VariantsView({ message: m }: { message: VariantsMessage }) {
  return (
    <div className="msg msg-assistant msg-variants" aria-label="Variants">
      {m.items.map((v) => (
        <div key={v.n} className={`variant-item is-${v.status}`}>
          <p className="variant-head">
            <span className="comment-number">{v.n}</span>
            <span className="truncate">{v.model}</span>
            <span className="muted">
              {v.status === "running" ? "Working…" : v.status === "done" ? "Ready" : v.status === "stopped" ? "Stopped" : "Failed"}
            </span>
          </p>
          {v.text && <p className="variant-text">{v.text}</p>}
          {v.error && <p className="variant-error">{v.error}</p>}
          {v.usage && (
            <p className="msg-meta">
              <span title="Input, output and cached tokens">
                {formatTokens(v.usage.inputTokens)} in · {formatTokens(v.usage.outputTokens)} out
                {v.usage.cachedTokens > 0 && ` · ${formatTokens(v.usage.cachedTokens)} cached`}
              </span>
            </p>
          )}
        </div>
      ))}
      {m.status === "running" && m.items.length === 0 && <p className="msg-info">Starting the variants…</p>}
      {m.status === "done" && <p className="msg-info">Pick a variant on the canvas. The others stay in the version history.</p>}
      {m.status === "stopped" && <p className="msg-info">Stopped.</p>}
      {m.error && (
        <div className="notice notice-danger" role="alert">
          <Icon name="alert" />
          <p className="notice-text">{m.error}</p>
        </div>
      )}
    </div>
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
          {a.commentsDone !== undefined && (
            <span>{a.commentsDone} comment{a.commentsDone === 1 ? "" : "s"} done</span>
          )}
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
