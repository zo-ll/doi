import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";

export interface Selection {
  oid: string;
  rect: { x: number; y: number; width: number; height: number };
  /** The frame that reported the selection. */
  frame: string;
}

type Message =
  | { id: number; kind: "user"; text: string; target?: string }
  | { id: number; kind: "error"; text: string };

const SUGGESTIONS = [
  "A pricing page with three plans and a FAQ",
  "A dashboard home for a fitness app",
  "Make the hero more compact",
];

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function ChatPanel({ selection, model, disabled, onClearSelection }: {
  selection: Selection | null;
  model: string | null;
  disabled: boolean;
  onClearSelection: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

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

  const send = () => {
    const text = draft.trim();
    if (!text || running || disabled) return;
    const id = nextId.current;
    nextId.current += 2;
    setMessages((m) => [
      ...m,
      { id, kind: "user", text, target: selection?.oid },
      // Replaced by the streamed answer when the generation endpoint exists (#7, #8).
      { id: id + 1, kind: "error", text: "Generation is not available yet. See issues #7 and #8." },
    ]);
    setDraft("");
  };

  const stop = () => setRunning(false);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      stop();
    }
  };

  const canSend = draft.trim().length > 0 && !disabled;

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
            ) : (
              <div key={m.id} className="notice notice-danger" role="alert">
                <Icon name="alert" />
                <p className="notice-text">{m.text}</p>
              </div>
            ),
          )
        )}
      </div>

      <div className="composer-wrap">
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
            {model && <span className="composer-model truncate">{model}</span>}
            {running ? (
              <button className="btn btn-secondary" onClick={stop} title="Stop (Esc)">
                <Icon name="stop" size={14} />
                Stop
              </button>
            ) : (
              <button className="btn btn-primary" onClick={send} disabled={!canSend} title={`Send (${isMac ? "⌘" : "Ctrl"}+Enter)`}>
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
