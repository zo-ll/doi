import { useEffect, useRef } from "react";

/** A modal question before an action that changes or removes something (UI kit: confirm dialog). */
export function Confirm({ title, body, action, danger = false, busy = false, error = null, onConfirm, onCancel }: {
  title: string;
  body: string;
  action: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="confirm" role="alertdialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{body}</p>
        {error && (
          <div className="banner banner-err" role="alert">
            <span className="dot dot-err" />
            {error}
          </div>
        )}
        <div className="confirm-actions">
          <button className="btn btn-secondary btn-lg" onClick={onCancel}>
            Cancel<span className="kbd">Esc</span>
          </button>
          <button ref={ref} className={`btn btn-lg ${danger ? "btn-danger" : "btn-primary"}`} disabled={busy} onClick={onConfirm}>
            {action}
          </button>
        </div>
      </div>
    </div>
  );
}
