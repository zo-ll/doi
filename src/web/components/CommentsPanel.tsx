import { useState } from "react";
import type { CommentView, Load } from "../api.ts";
import type { Selection } from "./ChatPanel.tsx";
import { Icon } from "./Icon.tsx";

export function CommentsPanel({ comments, selection, running, onSelect, onAdd, onStatus, onRemove, onRetry, onApply }: {
  comments: Load<CommentView[]>;
  selection: Selection | null;
  /** A turn runs in the chat; no new one can start. */
  running: boolean;
  onSelect: (oid: string) => void;
  onAdd: (oid: string, text: string) => Promise<void>;
  onStatus: (id: string, status: "open" | "done") => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onRetry: () => void;
  /** Runs one turn in the chat for these comments. */
  onApply: (comments: CommentView[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each action shows the server's message when it fails.
  const act = async (job: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await job();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!selection || !draft.trim() || busy) return;
    if (await act(() => onAdd(selection.oid, draft))) setDraft("");
  };

  const list = comments.state === "ready" ? comments.data : [];
  const open = list.filter((c) => c.status === "open").length;
  // A detached comment has no element to change.
  const applicable = list.filter((c) => c.status === "open" && !c.detached);

  return (
    <div className="comments">
      <div className="comments-list">
        {comments.state === "loading" && <div className="skeleton comments-skeleton" aria-label="Loading comments" />}
        {comments.state === "error" && (
          <div className="notice notice-danger" role="alert">
            <Icon name="alert" />
            <span>Comments cannot load: {comments.message}</span>
            <button className="link-btn" onClick={onRetry}>Try again</button>
          </div>
        )}
        {comments.state === "ready" && list.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-icon"><Icon name="comment" size={20} /></div>
            <h2>No comments</h2>
            <p>Comments on elements of this design show here, with a pin on the canvas.</p>
          </div>
        )}
        {list.length > 0 && (
          <div className="comments-bar">
            <p className="comments-count muted">
              {open} open · {list.length - open} done
            </p>
            {applicable.length > 0 && (
              <button
                className="btn btn-secondary"
                disabled={running || busy}
                onClick={() => onApply(applicable)}
                title={running ? "Wait for the running turn to end" : "Run one turn for all open comments"}
              >
                <Icon name="sparkle" />
                Apply all comments
              </button>
            )}
          </div>
        )}
        {list.map((c, i) => (
          <article
            key={c.id}
            className={`comment${c.status === "done" ? " is-done" : ""}${selection?.oid === c.oid ? " is-active" : ""}`}
            aria-label={`Comment ${i + 1}`}
          >
            <div className="comment-head">
              <span className="comment-number">{i + 1}</span>
              <button
                className="chip chip-accent comment-target"
                onClick={() => onSelect(c.oid)}
                disabled={c.detached}
                title={c.detached ? "This element is not in the design now" : "Select this element"}
              >
                <Icon name="target" size={12} />
                <span className="truncate">{c.oid}</span>
              </button>
              {c.detached && <span className="badge badge-warning">Detached</span>}
              <span className="comment-actions">
                {c.status === "open" && !c.detached && (
                  <button
                    className="icon-btn"
                    disabled={running || busy}
                    onClick={() => onApply([c])}
                    aria-label={`Apply comment ${i + 1}`}
                    title="Apply this comment"
                  >
                    <Icon name="sparkle" />
                  </button>
                )}
                <button
                  className="icon-btn"
                  disabled={busy}
                  onClick={() => act(() => onStatus(c.id, c.status === "open" ? "done" : "open"))}
                  aria-label={c.status === "open" ? `Mark comment ${i + 1} as done` : `Open comment ${i + 1} again`}
                  title={c.status === "open" ? "Mark as done" : "Open again"}
                >
                  <Icon name={c.status === "open" ? "check" : "undo"} />
                </button>
                <button
                  className="icon-btn"
                  disabled={busy}
                  onClick={() => act(() => onRemove(c.id))}
                  aria-label={`Delete comment ${i + 1}`}
                  title="Delete"
                >
                  <Icon name="trash" />
                </button>
              </span>
            </div>
            <p className="comment-text">{c.text}</p>
          </article>
        ))}
      </div>

      <div className="composer-wrap">
        {selection ? (
          <div className="composer">
            <div className="composer-context">
              <span className="chip chip-accent">
                <Icon name="target" size={12} />
                <span className="truncate">{selection.oid}</span>
              </span>
              <span className="muted">New comment on this element</span>
            </div>
            {error && <p className="composer-image-error" role="alert">{error}</p>}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="Write a comment…"
              aria-label="Comment text"
              rows={2}
            />
            <div className="composer-actions">
              <span className="composer-model" />
              <button className="btn btn-primary" disabled={!draft.trim() || busy} onClick={() => void submit()}>
                Comment <kbd>Ctrl↵</kbd>
              </button>
            </div>
          </div>
        ) : (
          <>
            {error && <p className="composer-image-error" role="alert">{error}</p>}
            <p className="comments-hint muted">Select an element on the canvas to comment on it.</p>
          </>
        )}
      </div>
    </div>
  );
}
