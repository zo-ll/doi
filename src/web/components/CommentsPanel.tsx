import { useEffect, useRef, useState } from "react";
import type { CommentView, Load } from "../api.ts";
import type { Selection } from "./ChatPanel.tsx";
import { MOD } from "./TopBar.tsx";

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function CommentsPanel({
  comments,
  selection,
  adding,
  onAdding,
  applied,
  onSelect,
  onAdd,
  onEdit,
  onStatus,
  onRemove,
  onRetry,
  onToggleApply,
}: {
  comments: Load<CommentView[]>;
  selection: Selection | null;
  /** The new-comment form is open. */
  adding: boolean;
  onAdding: (adding: boolean) => void;
  /** Ids of the comments that go with the next turn. */
  applied: string[];
  onSelect: (oid: string) => void;
  onAdd: (oid: string, text: string) => Promise<void>;
  onEdit: (id: string, text: string) => Promise<void>;
  onStatus: (id: string, status: "open" | "done") => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onRetry: () => void;
  /** Puts a comment into the next turn, or takes it out. `n` is its number. */
  onToggleApply: (c: CommentView, n: number) => void;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The form state lives in the app: a save that ends after this panel left must not close a newer form. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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

  const add = async () => {
    if (!selection || !draft.trim() || busy) return;
    if (await act(() => onAdd(selection.oid, draft.trim()))) {
      setDraft("");
      if (mounted.current) onAdding(false);
    }
  };
  const saveEdit = async () => {
    if (!editing || !editing.text.trim() || busy) return;
    if (await act(() => onEdit(editing.id, editing.text.trim()))) setEditing(null);
  };

  const list = comments.state === "ready" ? comments.data : [];
  const numbered = list.map((c, i) => ({ c, n: i + 1 }));
  const open = numbered.filter(({ c }) => c.status === "open");
  const done = numbered.filter(({ c }) => c.status === "done");

  return (
    <div className="comments">
      <div className="comments-bar">
        <span className="panel-meta">
          {comments.state === "ready" ? `${open.length} open · ${done.length} done` : ""}
        </span>
        <span className="spacer" />
        <button
          className="btn btn-secondary btn-md"
          disabled={!selection}
          onClick={() => onAdding(true)}
          title={selection ? `New comment on ${selection.oid} (N)` : "Select an element on the canvas first"}
        >
          New comment<span className="kbd">N</span>
        </button>
      </div>

      {error && (
        <div className="banner banner-err comments-error" role="alert">
          <span className="dot dot-err" />
          {error}
        </div>
      )}

      {adding && selection && (
        <div className="comment-new">
          <div className="comment-new-target">on {selection.oid}</div>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void add();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                onAdding(false);
              }
            }}
            rows={3}
            aria-label="Comment"
            placeholder="What should change here?"
          />
          <div className="comment-new-actions">
            <button className="btn btn-ghost btn-md" onClick={() => onAdding(false)}>
              Cancel
            </button>
            <button className="btn btn-primary btn-md" disabled={!draft.trim() || busy} onClick={() => void add()} title={`Add (${MOD}↵)`}>
              Add comment
            </button>
          </div>
        </div>
      )}

      {comments.state === "loading" && (
        <div className="comments-list" aria-busy="true" aria-label="Loading comments">
          <div className="skeleton comment-skeleton" />
          <div className="skeleton comment-skeleton" />
        </div>
      )}
      {comments.state === "error" && (
        <div className="banner banner-err comments-error" role="alert">
          <span className="dot dot-err" />
          <span className="spacer">Comments cannot load: {comments.message}</span>
          <button className="btn btn-secondary btn-sm" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {comments.state === "ready" && list.length === 0 && !adding && (
        <p className="comments-empty">No comments yet. Select an element on the canvas and press N, or use the Comment tool (C).</p>
      )}

      <div className="comments-list">
        {open.map(({ c, n }) => {
          const isApplied = applied.includes(c.id);
          const isEditing = editing?.id === c.id;
          return (
            <article
              key={c.id}
              className={`comment-card${selection?.oid === c.oid ? " is-active" : ""}`}
              aria-label={`Comment ${n}`}
              onClick={() => !c.detached && onSelect(c.oid)}
            >
              <div className="comment-head">
                <span className={`pin-badge${c.detached ? " is-detached" : ""}`}>{n}</span>
                <span className="comment-el truncate">{c.oid}</span>
                <span className="comment-time">{time(c.createdAt)}</span>
              </div>
              {c.detached && (
                <span className="comment-detached">
                  <span className="dot dot-warn" />
                  Detached · element not in the design now
                </span>
              )}
              {isEditing ? (
                <textarea
                  className="textarea comment-edit"
                  value={editing.text}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      void saveEdit();
                    } else if (e.key === "Escape") {
                      e.stopPropagation();
                      setEditing(null);
                    }
                  }}
                  autoFocus
                  rows={3}
                  aria-label="Edit comment"
                />
              ) : (
                <p className="comment-text">{c.text}</p>
              )}
              {confirm === c.id && (
                <div className="comment-confirm" onClick={(e) => e.stopPropagation()}>
                  <span className="spacer">Delete comment {n}? This can't be undone.</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={() => {
                      setConfirm(null);
                      void act(() => onRemove(c.id));
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
              <div className="comment-actions" onClick={(e) => e.stopPropagation()}>
                {isEditing ? (
                  <>
                    <button className="btn btn-primary btn-sm" disabled={busy || !editing.text.trim()} onClick={() => void saveEdit()}>
                      Save
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className={`apply-toggle${isApplied ? " is-on" : ""}`}
                      aria-pressed={isApplied}
                      disabled={c.detached}
                      onClick={() => onToggleApply(c, n)}
                      title={c.detached ? "Its element is gone: edit or delete it" : "Send with the next chat turn"}
                    >
                      <span className="apply-box" />
                      {isApplied ? "Applied to next turn" : "Apply"}
                    </button>
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => onStatus(c.id, "done"))}>
                      Done
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing({ id: c.id, text: c.text })}>
                      Edit
                    </button>
                    <span className="spacer" />
                    <button className="btn btn-ghost btn-sm comment-delete" onClick={() => setConfirm(c.id)}>
                      Delete
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {done.length > 0 && (
        <>
          <div className="comments-done-label">Done · {done.length}</div>
          <div className="comments-done">
            {done.map(({ c, n }) => (
              <div key={c.id} className="comment-done" onClick={() => !c.detached && onSelect(c.oid)}>
                <span className="pin-badge is-done">{n}</span>
                <div className="comment-done-body">
                  <span className="comment-done-text">{c.text}</span>
                  <span className="comment-el">{c.oid}</span>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void act(() => onStatus(c.id, "open"));
                  }}
                >
                  Reopen
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
