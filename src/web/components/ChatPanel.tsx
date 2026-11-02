import { useEffect, useRef, useState } from "react";
import { chatUrl, getJSON, turnUrl, uploadUrl, variantsUrl, type Active, type ChatEntryView, type VariantStreamEvent } from "../api.ts";
import { isImageType, prepareImage, type PreparedImage } from "../images.ts";
import { IMAGE_LIMITS } from "../../workspace/image-limits.ts";
import {
  applyEvent,
  applyVariantEvent,
  clock,
  formatTokens,
  fromEntries,
  newAnswer,
  readEvents,
  shown,
  type Answer,
  type ChatMessage,
  type Task,
  type VariantsMessage,
} from "../chat.ts";
import { shortModel, type TaskStatus } from "../providers.ts";
import { MOD } from "./TopBar.tsx";

/** The selected element. Each frame finds it by its data-oid and draws it. */
export interface Selection {
  oid: string;
}

/** A comment the user marked "apply": it goes with the next turn. `n` is its number in the list. */
export interface AppliedComment {
  id: string;
  oid: string;
  text: string;
  n: number;
}

type NewMessage = ChatMessage extends infer M ? (M extends ChatMessage ? Omit<M, "id"> : never) : never;

/** What a turn sent, so Retry can send it again. */
interface Sent {
  text: string;
  target: string | null;
  images: PreparedImage[];
  comments: AppliedComment[];
  count: number;
}

const SAMPLES = [
  "A pricing page with three plans, a comparison table and a FAQ",
  "A dashboard home for a fitness app: today's goal, streak and the last workouts",
  "A calm landing page for a note-taking app, with one accent color",
];

const TONE_DOT = { ok: "dot-ok", warn: "dot-warn", err: "dot-err", unknown: "" } as const;
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "");
const usageLine = (u: { inputTokens: number; outputTokens: number; cachedTokens: number }) =>
  `in ${formatTokens(u.inputTokens)} · out ${formatTokens(u.outputTokens)} · cached ${formatTokens(u.cachedTokens)}`;

/**
 * The chat of one design. App mounts it with key = the design, so a design switch starts a
 * new panel: a run of the old design is aborted, and its messages cannot reach the new one.
 */
export function ChatPanel({
  target,
  selection,
  tasks,
  onClearSelection,
  applied = [],
  onUnapply,
  onAppliedSent,
  onRunningChange,
  onCommentsChanged,
  variantsOpen = false,
  onVariantsChanged,
  onDiscardVariants,
  onCollapse,
  onOpenSettings,
  repo = null,
}: {
  /** The open design; null disables the composer. */
  target: Active | null;
  selection: Selection | null;
  /** The model and status of each task (generate, edit, extract). */
  tasks: TaskStatus[];
  onClearSelection: () => void;
  /** Comments to send with the next turn. */
  applied?: AppliedComment[];
  onUnapply?: (id: string) => void;
  /** The applied comments went with a turn. */
  onAppliedSent?: () => void;
  onRunningChange?: (running: boolean) => void;
  /** A turn marked comments done. */
  onCommentsChanged?: () => void;
  /** The design has open variants: no turn can start until one is picked or they are discarded. */
  variantsOpen?: boolean;
  /** A variants run changed the open set. */
  onVariantsChanged?: () => void;
  onDiscardVariants?: () => void;
  onCollapse: () => void;
  onOpenSettings: () => void;
  /** The project's linked repo: the samples start from the app's code. */
  repo?: string | null;
}) {
  const disabled = target === null;
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  // 1 is a normal turn; 2 to 4 starts that many variants.
  const [count, setCount] = useState(1);
  /** A model the user picked for this design's turns; null uses the config. */
  const [chosen, setChosen] = useState<TaskStatus | null>(null);
  const [modelMenu, setModelMenu] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const abortRef = useRef<AbortController | null>(null);
  const sentRef = useRef(new Map<number, Sent>());

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

  const push = (m: NewMessage) => setMessages((list) => [...list, { ...m, id: nextId.current++ } as ChatMessage]);
  const updateAnswer = (id: number, f: (a: Answer) => Answer) =>
    setMessages((list) => list.map((m) => (m.id === id && m.kind === "assistant" ? f(m) : m)));
  const updateVariants = (id: number, f: (m: VariantsMessage) => VariantsMessage) =>
    setMessages((list) => list.map((m) => (m.id === id && m.kind === "variants" ? f(m) : m)));

  // The model of the next turn: the user's pick, or the edit model for a target, else generate.
  const byTask = (task: "generate" | "edit") => tasks.find((t) => t.task === task) ?? null;
  const current = chosen ?? byTask(selection ? "edit" : "generate");
  const currentTask: Task = selection ? "edit" : "generate";
  const modelRef = current ? `${current.provider}:${current.model}` : null;
  // Ready models from the config, one entry per provider and model.
  const choices = tasks.filter((t, i) => tasks.findIndex((x) => x.provider === t.provider && x.model === t.model) === i);

  /** Starts `n` variants of `text`. The answer streams into one message. */
  const sendVariants = async (s: Sent) => {
    if (!target) return;
    push({ kind: "user", text: s.text, at: new Date().toISOString(), ...(s.target ? { target: s.target } : {}) });
    const id = nextId.current++;
    setMessages((list) => [...list, { id, kind: "variants", status: "running", items: [] }]);
    sentRef.current.set(id, s);
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    try {
      const res = await fetch(variantsUrl(target.project, target.design), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: s.text, target: s.target, count: s.count, ...(modelRef ? { models: Array(s.count).fill(modelRef) } : {}) }),
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
    getJSON<ChatEntryView[]>(chatUrl(target.project, target.design))
      .then((entries) => {
        if (!live) return;
        const loaded = fromEntries(entries, () => nextId.current++, (name) => uploadUrl(target.project, name));
        // A stored turn can be sent again (without its images, which the server keeps as files).
        loaded.forEach((m, i) => {
          const before = loaded[i - 1];
          if (m.kind === "assistant" && before?.kind === "user") {
            sentRef.current.set(m.id, { text: before.text, target: before.target ?? null, images: [], comments: [], count: 1 });
          }
        });
        setMessages((list) => [...loaded, ...list]);
        // An empty design waits for its first prompt: the composer takes the focus.
        if (loaded.length === 0 && !document.querySelector('[aria-modal="true"], .nav-drawer')) inputRef.current?.focus();
      })
      .catch((e: unknown) => {
        if (live) push({ kind: "error", text: `The chat history could not load: ${e instanceof Error ? e.message : String(e)}` });
      });
    return () => {
      live = false;
    };
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

  /** Runs one turn. The answer streams into a new message. */
  const sendTurn = async (s: Sent) => {
    if (!target) return;
    push({
      kind: "user",
      text: s.text,
      at: new Date().toISOString(),
      ...(s.target ? { target: s.target } : {}),
      ...(s.images.length ? { images: s.images.map((i) => i.url) } : {}),
      ...(s.comments.length ? { comments: s.comments.map(({ oid, text }) => ({ oid, text })) } : {}),
    });
    const answerId = nextId.current++;
    sentRef.current.set(answerId, s);
    setMessages((list) => [...list, newAnswer(answerId, current?.model, chosen ? currentTask : s.target ? "edit" : "generate")]);

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    try {
      const res = await fetch(turnUrl(target.project, target.design), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: s.text,
          target: s.target,
          images: s.images.map(({ mediaType, data }) => ({ mediaType, data })),
          ...(s.comments.length ? { comments: s.comments.map((c) => c.id) } : {}),
          ...(chosen && modelRef ? { model: modelRef } : {}),
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
      if (!ended) updateAnswer(answerId, (a) => ({ ...a, status: "error", error: "The connection closed before the turn ended." }));
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

  const send = () => {
    const text = draft.trim();
    if ((!text && !applied.length) || running || !target) return;
    const s: Sent = { text, target: selection?.oid ?? null, images, comments: applied, count };
    setDraft("");
    setImages([]);
    setImageError(null);
    if (applied.length) onAppliedSent?.();
    void (count > 1 ? sendVariants(s) : sendTurn(s));
  };
  const retry = (id: number) => {
    const s = sentRef.current.get(id);
    if (!s || running) return;
    void (s.count > 1 ? sendVariants(s) : sendTurn(s));
  };

  // Esc closes the model menu, wherever the focus is.
  useEffect(() => {
    if (!modelMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setModelMenu(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [modelMenu]);

  /** On the whole composer: Ctrl/⌘ Enter sends from the text, the variant count or any other control. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canSend) send();
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      stop();
    }
  };

  // Variants take text only; images go with a normal turn.
  const variantsWithImages = count > 1 && images.length > 0;
  // The variants route takes text only: applied comments would be lost.
  const variantsWithComments = count > 1 && applied.length > 0;
  const hasInput = draft.trim().length > 0 || (applied.length > 0 && count === 1);
  const canSend = hasInput && !disabled && !variantsOpen && !variantsWithImages && !variantsWithComments;
  const modelProblem = current && (current.tone === "err" || current.tone === "warn") ? current : null;
  const turns = messages.filter((m) => m.kind === "user").length;
  const hasChips = selection !== null || applied.length > 0 || images.length > 0;

  return (
    <section className="chat" aria-label="Chat">
      <div className="panel-header">
        <span className="panel-title">Chat</span>
        <span className="panel-meta">{turns === 1 ? "1 turn" : `${turns} turns`}</span>
        <span className="spacer" />
        <button className="collapse-btn" onClick={onCollapse} title={`Collapse chat (${MOD}[)`} aria-label="Collapse chat">
          {MOD}[
        </button>
      </div>

      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <h2>Describe a design</h2>
            <p>The model writes HTML and CSS pages. Each frame on the canvas shows them at a different size.</p>
            <div className="chat-samples">
              {(repo ? [`Recreate the home page of ${repo}`, "Recreate the settings page from the code, then make it calmer", "A new onboarding screen that fits the app's style"] : SAMPLES).map((s) => (
                <button
                  key={s}
                  className="chat-sample"
                  disabled={disabled}
                  onClick={() => {
                    setDraft(s);
                    inputRef.current?.focus();
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.kind === "user" ? (
            <div key={m.id} className="turn-user">
              <div className="turn-meta">
                <span className="turn-who">You</span>
                <span>{time(m.at)}</span>
              </div>
              <div className="msg-card">
                {(m.target || m.comments?.length) && (
                  <div className="msg-chips">
                    {m.target && (
                      <span className="chip chip-accent">
                        <span className="el-mark" />
                        {m.target}
                      </span>
                    )}
                    {m.comments?.map((c, i) => (
                      <span key={i} className="chip chip-outline" title={c.text}>
                        Comment on {c.oid}
                      </span>
                    ))}
                  </div>
                )}
                {m.text && <p className="msg-text">{m.text}</p>}
                {m.images && (
                  <div className="msg-images">
                    {m.images.map((src, i) => (
                      <img key={i} src={src} alt={`Attached image ${i + 1}`} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : m.kind === "assistant" ? (
            <AnswerView key={m.id} answer={m} running={running} onRetry={() => retry(m.id)} onOtherModel={() => setModelMenu(true)} />
          ) : m.kind === "variants" ? (
            <VariantsLine key={m.id} message={m} />
          ) : m.kind === "error" ? (
            <div key={m.id} className="banner banner-err" role="alert">
              <span className="dot dot-err" />
              {m.text}
            </div>
          ) : (
            <p key={m.id} className="msg-info">
              {m.text}
            </p>
          ),
        )}
      </div>

      <div className="composer-wrap">
        {variantsOpen && (
          <div className="banner banner-warn" role="status">
            <span className="dot dot-warn" />
            <span className="spacer">A variant set is open. Pick one or discard all first.</span>
            {onDiscardVariants && (
              <button className="btn btn-secondary btn-sm" onClick={onDiscardVariants}>
                Discard all
              </button>
            )}
          </div>
        )}
        {!variantsOpen && modelProblem && (
          <div className="banner banner-warn" role="status">
            <span className="dot dot-warn" />
            <span className="spacer">
              {modelProblem.model}: {modelProblem.label.toLowerCase()}. {modelProblem.via}
            </span>
            <button className="btn btn-secondary btn-sm" onClick={() => setModelMenu(true)}>
              Use another model
            </button>
          </div>
        )}
        <div
          className={`composer${disabled ? " is-disabled" : ""}${dragging ? " is-dragging" : ""}`}
          onKeyDown={onKeyDown}
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
            setDragging(false);
            const files = [...e.dataTransfer.files];
            // Only images belong here; the window takes a .zip (import) and blocks other files.
            if (!files.some((f) => f.type.startsWith("image/"))) return;
            e.preventDefault();
            void addImages(files);
          }}
        >
          {hasChips && (
            <div className="composer-chips">
              {selection && (
                <span className="chip chip-accent" title="Edits apply to this element">
                  <span className="el-mark" />
                  <span className="truncate">{selection.oid}</span>
                  <span className="chip-note">· edits apply here</span>
                  <button className="chip-close" onClick={onClearSelection} aria-label="Remove target element" title="Remove (Esc)">
                    ×
                  </button>
                </span>
              )}
              {applied.map((c) => (
                <span key={c.id} className="chip chip-outline chip-comment" title={c.text}>
                  <strong>#{c.n}</strong>
                  <span className="truncate">{c.text}</span>
                  <button className="chip-close" onClick={() => onUnapply?.(c.id)} aria-label={`Don't apply comment ${c.n}`}>
                    ×
                  </button>
                </span>
              ))}
              {images.map((img, i) => (
                <span key={i} className="composer-thumb" title={`Image ${i + 1}`}>
                  <img src={img.url} alt={`Image ${i + 1} to send`} />
                  <button aria-label={`Remove image ${i + 1}`} onClick={() => setImages((list) => list.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {imageError && (
            <p className="field-error composer-error" role="alert">
              {imageError}
            </p>
          )}
          {variantsWithImages && (
            <p className="field-error composer-error" role="alert">
              Variants do not take images. Remove the images, or make one design.
            </p>
          )}
          {variantsWithComments && (
            <p className="field-error composer-error" role="alert">
              Variants do not take comments. Remove the comments, or make one design.
            </p>
          )}
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
              if (files.length) {
                e.preventDefault();
                void addImages(files);
              }
            }}
            placeholder={disabled ? "Open a design to start" : selection ? "Describe a change to this element…" : "Describe a design or a change…"}
            rows={3}
            disabled={disabled}
            aria-label="Message"
          />
          <div className="composer-actions">
            <label className={`btn btn-ghost btn-md${disabled || images.length >= IMAGE_LIMITS.count ? " is-disabled" : ""}`} title="Attach images (paste or drop works too)">
              Attach
              <input
                type="file"
                className="visually-hidden"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                disabled={disabled || images.length >= IMAGE_LIMITS.count}
                onChange={(e) => {
                  void addImages([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
            </label>
            <div className="seg" role="radiogroup" aria-label="Variants" title="One design or 2–4 variants">
              {[1, 2, 3, 4].map((n) => (
                <button key={n} className="seg-item" role="radio" aria-checked={count === n} disabled={disabled || running} onClick={() => setCount(n)}>
                  {n === 1 ? "One" : n}
                </button>
              ))}
            </div>
            <span className="spacer" />
            {current && (
              <button
                className={`model-chip${chosen ? " is-chosen" : ""}`}
                onClick={() => setModelMenu((o) => !o)}
                aria-expanded={modelMenu}
                title={`${current.provider}:${current.model} · ${chosen ? "chosen for this design" : `config.toml → ${currentTask}`}`}
              >
                <span className={`dot ${TONE_DOT[current.tone]}`} />
                <span className="truncate">{shortModel(current.model)}</span>
              </button>
            )}
            {running ? (
              <button className="btn btn-secondary btn-md" onClick={stop} title="Stop (Esc)">
                <span className="stop-square" />
                Stop
              </button>
            ) : (
              <button className="btn btn-primary btn-md" onClick={send} disabled={!canSend} title={`Send (${MOD}↵)`}>
                {count > 1 ? `Make ${count}` : "Send"}
              </button>
            )}
          </div>
          {modelMenu && (
            <>
              <div className="popover-layer" onMouseDown={() => setModelMenu(false)} />
              <div className="menu model-menu" role="menu" aria-label="Model">
                <div className="menu-label">Model for this design · from config.toml</div>
                {chosen && (
                  <button
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      setChosen(null);
                      setModelMenu(false);
                    }}
                  >
                    Use the config: generate and edit models
                  </button>
                )}
                {choices.map((t) => {
                  const on = chosen ? chosen.provider === t.provider && chosen.model === t.model : false;
                  return (
                    <button
                      key={`${t.provider}:${t.model}`}
                      className="menu-item"
                      role="menuitemradio"
                      aria-checked={on}
                      disabled={t.tone !== "ok"}
                      onClick={() => {
                        setChosen(t);
                        setModelMenu(false);
                      }}
                    >
                      <span className={`dot ${TONE_DOT[t.tone]}`} />
                      <span className="mono truncate">{t.model}</span>
                      <span className="meta">
                        {t.provider}
                        {on ? " ✓" : ""}
                      </span>
                    </button>
                  );
                })}
                <div className="menu-sep" />
                <button
                  className="menu-item"
                  onClick={() => {
                    setModelMenu(false);
                    onOpenSettings();
                  }}
                >
                  Models and providers…<span className="meta">{MOD},</span>
                </button>
              </div>
            </>
          )}
        </div>
        <div className="composer-hints">
          <span>{MOD}↵ send</span>
          <span>Esc stop</span>
          <span title="Each click on the selection selects one level deeper">click: deeper</span>
          <span>{MOD}-click deepest</span>
          <span>⇧-click parent</span>
        </div>
      </div>
    </section>
  );
}

function VariantsLine({ message: m }: { message: VariantsMessage }) {
  const done = m.items.filter((v) => v.status === "done").length;
  const state =
    m.status === "running"
      ? m.items.length
        ? `${done} of ${m.items.length} done`
        : "Starting…"
      : m.status === "done"
        ? "Pick one on the canvas"
        : m.status === "stopped"
          ? "Stopped"
          : "Failed";
  return (
    <div className="turn-ai">
      <div className="variants-line">
        <span className="variants-line-label">Variants · {m.items.length || "…"}</span>
        <span className="spacer" />
        {m.status === "running" && <span className="spinner" />}
        <span className="muted">{state}</span>
      </div>
      {m.error && (
        <div className="banner banner-err" role="alert">
          <span className="dot dot-err" />
          {m.error}
        </div>
      )}
    </div>
  );
}

/** The seconds since `since` (an ISO time), counted while `on`. */
function useElapsed(since: string | undefined, on: boolean): number {
  const start = since ? Date.parse(since) : Date.now();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return Math.max(0, Math.floor((now - start) / 1000));
}

function AnswerView({ answer: a, running, onRetry, onOtherModel }: { answer: Answer; running: boolean; onRetry: () => void; onOtherModel: () => void }) {
  const streaming = a.status === "running";
  const elapsed = useElapsed(a.at, streaming);
  const none = null as number | null;
  const files = (
    streaming && a.files.length === 0
      ? (a.proposed ?? []).map((file) => ({ file, add: none, del: none }))
      : (a.stats ?? a.files.map((file) => ({ file, add: none, del: none })))
  ).filter((f) => shown(f.file));
  return (
    <div className="turn-ai">
      <div className="turn-meta">
        {a.model && <span className="turn-model">{a.model}</span>}
        {a.task && <span>· {a.task}</span>}
        {a.at && <span>· {time(a.at)}</span>}
      </div>
      {a.text && (
        <p className="msg-text">
          {a.text}
          {streaming && <span className="stream-cursor" />}
        </p>
      )}
      {streaming && (
        <p className="turn-progress">
          <span className="spinner" />
          <span className="spacer">
            {a.retries > 0
              ? `Some changes did not match. Trying again (${a.retries})…`
              : a.writing && shown(a.writing)
                ? `Writing ${a.writing}…`
                : a.text || a.proposed?.length
                  ? "Working…"
                  : "Thinking…"}
          </span>
          <span className="turn-elapsed" title="Time since you sent the message">
            {clock(elapsed)}
          </span>
        </p>
      )}
      {files.length > 0 && (
        <div className="turn-files">
          {files.map((f) => (
            <div key={f.file} className="turn-file">
              <span className="spacer truncate">{f.file}</span>
              {f.add !== null && f.add > 0 && <span className="add">+{f.add}</span>}
              {f.del !== null && f.del > 0 && <span className="del">−{f.del}</span>}
            </div>
          ))}
        </div>
      )}
      {a.status === "done" && (
        <p className="turn-tokens" title="Input, output and cached tokens">
          {a.usage ? usageLine(a.usage) : "no token count"}
          {a.commentsDone !== undefined && ` · ${a.commentsDone} comment${a.commentsDone === 1 ? "" : "s"} done`}
        </p>
      )}
      {a.commitError && <p className="msg-info">The change was not saved in the version history: {a.commitError}</p>}
      {a.status === "error" && (
        <div className="turn-error" role="alert">
          <p className="turn-error-title">
            <span className="dot dot-err" />
            The turn failed
          </p>
          <p>
            {a.error}
            {a.files.length === 0 && " No files changed."}
          </p>
          <div className="turn-error-actions">
            <button className="btn btn-secondary btn-md" onClick={onRetry} disabled={running}>
              Retry
            </button>
            <button className="btn btn-ghost btn-md" onClick={onOtherModel}>
              Use another model
            </button>
          </div>
        </div>
      )}
      {a.status === "stopped" && (
        <div className="turn-stopped">
          <span className="dot dot-stopped" />
          Stopped by you.{a.files.length === 0 && " No files changed."}
          <button className="btn btn-secondary btn-sm" onClick={onRetry} disabled={running}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
