import { useEffect, useRef, useState } from "react";
import { chatUrl, getJSON, turnUrl, uploadUrl, type Active, type ChatEntryView } from "../api.ts";
import { parseAsk } from "../ask.ts";
import { AskCard } from "./AskCard.tsx";
import { modelChoices, useComposerImages } from "../composer.ts";
import type { PreparedImage } from "../images.ts";
import { ModelMenu, TONE_DOT } from "./ModelMenu.tsx";
import { IMAGE_LIMITS } from "../../workspace/image-limits.ts";
import {
  applyEvent,
  clock,
  formatTokens,
  fromEntries,
  newAnswer,
  readEvents,
  shown,
  type Answer,
  stoppedText,
  UNFINISHED,
  type ChatMessage,
  type Task,
} from "../chat.ts";
import { shortModel, type TaskStatus } from "../providers.ts";
import { MOD, MOD_CLICK } from "./TopBar.tsx";

/** The selected element. Each frame finds it by its data-oid and draws it. */
export interface Selection {
  oid: string;
}

/** The message that the start screen hands to the chat of the new project. */
export interface FirstTurn {
  text: string;
  images: PreparedImage[];
  model: TaskStatus | null;
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
}

const SAMPLES = [
  "A pricing page with three plans, a comparison table and a FAQ",
  "A dashboard home for a fitness app: today's goal, streak and the last workouts",
  "A calm landing page for a note-taking app, with one accent color",
];

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
  onCollapse,
  onOpenSettings,
  repo = null,
  readOnlyReason,
  first,
  onFirstTaken,
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
  onCollapse: () => void;
  onOpenSettings: () => void;
  /** The project's linked repo: the samples start from the app's code. */
  repo?: string | null;
  /** Another artifact owns the canvas; HTML generation must not start from this view. */
  readOnlyReason?: string;
  /** The first message of a new project: this panel sends it when it starts. */
  first?: FirstTurn | null;
  onFirstTaken?: () => void;
}) {
  const disabled = target === null || !!readOnlyReason;
  const [draft, setDraft] = useState("");
  const { images, setImages, imageError, setImageError, addImages } = useComposerImages();
  const [dragging, setDragging] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunningState] = useState(false);
  /** The parent hears at once. A run that a design switch or an unmount aborted still ends here. */
  const setRunning = (on: boolean) => {
    setRunningState(on);
    onRunningChange?.(on);
  };
  /** A model the user picked for this design's turns; null uses the config. */
  const [chosen, setChosen] = useState<TaskStatus | null>(first?.model ?? null);
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
  // The model of the next turn: the user's pick, or the edit model for a target, else generate.
  const byTask = (task: "generate" | "edit") => tasks.find((t) => t.task === task) ?? null;
  const current = chosen ?? byTask(selection ? "edit" : "generate");
  const currentTask: Task = selection ? "edit" : "generate";
  const modelRef = current ? `${current.provider}:${current.model}` : null;
  // Ready models from the config, one entry per provider and model.
  const choices = modelChoices(tasks);

  // Load the stored chat. Messages sent before it arrives stay after it.
  useEffect(() => {
    if (!target) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let shownIds = new Set<number>();
    const load = (attempt: number) =>
      getJSON<ChatEntryView[]>(chatUrl(target.project, target.design))
      .then((entries) => {
        if (!live) return;
        const loaded = fromEntries(entries, () => nextId.current++, (name) => uploadUrl(target.project, name));
        // After a reload during a turn, the server can still be writing that turn's answer:
        // load again a few times while the newest turn has no answer.
        const last = loaded.at(-1);
        if (last?.kind === "info" && last.text === UNFINISHED && attempt < 3) timer = setTimeout(() => void load(attempt + 1), 1500);
        // A stored turn can be sent again (without its images, which the server keeps as files).
        loaded.forEach((m, i) => {
          const before = loaded[i - 1];
          if (m.kind === "assistant" && before?.kind === "user") {
            sentRef.current.set(m.id, { text: before.text, target: before.target ?? null, images: [], comments: [] });
          }
        });
        const before = shownIds;
        shownIds = new Set(loaded.map((m) => m.id));
        setMessages((list) => [...loaded, ...list.filter((m) => !before.has(m.id))]);
        // An empty design waits for its first prompt: the composer takes the focus.
        if (attempt === 0 && loaded.length === 0 && !document.querySelector('[aria-modal="true"], .nav-drawer')) inputRef.current?.focus();
      })
      .catch((e: unknown) => {
        if (live && attempt === 0) push({ kind: "error", text: `The chat history could not load: ${e instanceof Error ? e.message : String(e)}` });
      });
    void load(0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [target?.project, target?.design]);

  // Stop a running request when the panel unmounts or the design changes.
  useEffect(() => () => abortRef.current?.abort(), [target?.project, target?.design]);

  /** Runs one turn. The answer streams into a new message. */
  const sendTurn = async (s: Sent) => {
    if (!target || readOnlyReason) return;
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
      if (!ended) {
        // After the user's stop the server ends the stream without a done event, maybe before the abort below lands.
        if (stoppedByUser.current === controller) updateAnswer(answerId, (a) => ({ ...a, status: "stopped", stop: "user" }));
        else updateAnswer(answerId, (a) => ({ ...a, status: "error", error: "The connection closed before the turn ended." }));
      }
    } catch (e) {
      if (controller.signal.aborted) {
        const byUser = stoppedByUser.current === controller;
        updateAnswer(answerId, (a) => ({ ...a, status: "stopped", ...(byUser ? { stop: "user" as const } : {}) }));
      } else updateAnswer(answerId, (a) => ({ ...a, status: "error", error: `The request failed: ${e instanceof Error ? e.message : String(e)}` }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  };

  /** The run that the user stopped (Stop, Esc), as opposed to a design switch or an unmount. */
  const stoppedByUser = useRef<AbortController | null>(null);
  /** Tells the server first, so it stores the stop as the user's; then ends the stream. */
  const stop = async () => {
    const controller = abortRef.current;
    if (!controller || controller.signal.aborted) return;
    stoppedByUser.current = controller;
    if (target) await fetch(turnUrl(target.project, target.design), { method: "DELETE" }).catch(() => {});
    controller.abort();
  };

  // The first message of a new project. The ref holds, because this effect must send it only once.
  const firstSent = useRef(false);
  useEffect(() => {
    if (!first || firstSent.current || !target) return;
    firstSent.current = true;
    onFirstTaken?.();
    void sendTurn({ text: first.text, target: null, images: first.images, comments: [] });
  }, [first]);

  const send = () => {
    const text = draft.trim();
    if ((!text && !applied.length) || running || !target) return;
    const s: Sent = { text, target: selection?.oid ?? null, images, comments: applied };
    setDraft("");
    setImages([]);
    setImageError(null);
    if (applied.length) onAppliedSent?.();
    void sendTurn(s);
  };
  /** Sends a turn that the composer did not make, so its vision warning cannot show. */
  const resend = (s: Sent) => {
    if (s.images.length && current?.vision === false) {
      setImageError(`${shortModel(current.model)} cannot read images. Pick a model with vision, then try again.`);
      setModelMenu(true);
      return;
    }
    setImageError(null);
    void sendTurn(s);
  };
  /**
   * The answer to an `ask` block goes as the next message, with the element and the images of the
   * request: the history keeps no old image. After a reload the panel has no images. The comments of
   * the request do not go again: the history has their text, and one can be done or gone by now.
   */
  const answerAsk = (id: number, text: string) => {
    if (running || !target) return;
    const sent = sentRef.current.get(id);
    resend({ text, target: sent?.target ?? null, images: sent?.images ?? [], comments: [] });
  };
  const retry = (id: number) => {
    const s = sentRef.current.get(id);
    if (s && !running) resend(s);
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

  /** On the whole composer: Ctrl/⌘ Enter sends from the text or any other control. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canSend) send();
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      stop();
    }
  };

  const hasInput = draft.trim().length > 0 || applied.length > 0;
  // The server refuses images for a model without vision; say so before Send.
  const imagesUnread = images.length > 0 && current?.vision === false;
  const visionChoice = choices.some((t) => t.tone === "ok" && t.vision === true);
  const canSend = hasInput && !disabled && !imagesUnread;
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
            <AnswerView key={m.id} answer={m} running={running || !!readOnlyReason} onRetry={() => retry(m.id)} onOtherModel={() => setModelMenu(true)} onAnswer={m.id === messages.at(-1)?.id && !running && !disabled ? (text) => answerAsk(m.id, text) : undefined} />
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
        {readOnlyReason && <p className="uml-hint" role="note">{readOnlyReason}</p>}
        {modelProblem && (
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
          {imagesUnread && current && (
            <p className="field-error composer-error" role="alert">
              {shortModel(current.model)} cannot read images. Remove the images, or pick a model with vision.{" "}
              {visionChoice && (
                <button className="link-btn" onClick={() => setModelMenu(true)}>
                  Pick a model
                </button>
              )}
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
            placeholder={readOnlyReason ? "Use the UML tools to edit this diagram" : disabled ? "Open a design to start" : selection ? "Describe a change to this element…" : "Describe a design or a change…"}
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
                Send
              </button>
            )}
          </div>
          {modelMenu && (
            <ModelMenu
              choices={choices}
              chosen={chosen}
              onChoose={(t) => {
                setChosen(t);
                setImageError(null); // a retry warning was about the model before
                setModelMenu(false);
              }}
              onClose={() => setModelMenu(false)}
              onOpenSettings={onOpenSettings}
            />
          )}
        </div>
        <div className="composer-hints">
          <span>{MOD}↵ send</span>
          <span>Esc stop</span>
          <span title="Each click on the selection selects one level deeper">click: deeper</span>
          <span>{MOD_CLICK}-click deepest</span>
          <span>⇧-click parent</span>
        </div>
      </div>
    </section>
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

function AnswerView({ answer: a, running, onRetry, onOtherModel, onAnswer }: { answer: Answer; running: boolean; onRetry: () => void; onOtherModel: () => void; onAnswer?: (text: string) => void }) {
  const streaming = a.status === "running";
  const ask = parseAsk(a.text, streaming);
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
      {ask.text && (
        <p className="msg-text">
          {ask.text}
          {streaming && <span className="stream-cursor" />}
        </p>
      )}
      {ask.questions && <AskCard questions={ask.questions} onAnswer={a.status === "done" ? onAnswer : undefined} />}
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
          {stoppedText(a)}
          <button className="btn btn-secondary btn-sm" onClick={onRetry} disabled={running}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
