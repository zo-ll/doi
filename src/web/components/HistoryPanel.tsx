import type { Load, VersionView } from "../api.ts";
import { shortModel } from "../providers.ts";
import { versionKind } from "../history.ts";

/** "just now", "5 min ago", "3 h ago", else the date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function HistoryPanel({ versions, preview, busy, onPreview, onRestore, onReopen, onRetry }: {
  versions: Load<VersionView[]>;
  /** The version shown on the canvas. */
  preview: string | null;
  onPreview: (v: VersionView | null) => void;
  /** Asks to restore the previewed version. */
  onRestore: () => void;
  /** A history action runs. */
  busy?: boolean;
  /** Brings back the variant set of a pick, to pick another variant. */
  onReopen?: (v: VersionView) => void;
  onRetry: () => void;
}) {
  const list = versions.state === "ready" ? versions.data : [];
  return (
    <div className="history">
      <p className="history-intro">Every turn, pick, restore and rename is a version. Restoring adds a new version; nothing is lost.</p>
      {versions.state === "loading" && (
        <div className="history-list" aria-busy="true" aria-label="Loading the history">
          <div className="skeleton comment-skeleton" />
          <div className="skeleton comment-skeleton" />
        </div>
      )}
      {versions.state === "error" && (
        <div className="banner banner-err history-error" role="alert">
          <span className="dot dot-err" />
          <span className="spacer">The history cannot load: {versions.message}</span>
          <button className="btn btn-secondary btn-sm" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {versions.state === "ready" && list.length === 0 && <p className="comments-empty">No versions yet. The first completed turn makes v1.</p>}
      <div className="history-list">
        {list.map((v, i) => {
          const n = list.length - i;
          const current = i === 0;
          const previewing = preview === v.sha;
          return (
            <div key={v.sha} className={`version${previewing ? " is-previewing" : ""}`}>
              <span className={`version-dot${current ? " is-current" : previewing ? " is-previewing" : ""}`} />
              <div className="version-body">
                <div className="version-head">
                  <span className="version-n">v{n}</span>
                  <span className="badge">{versionKind(v.message)}</span>
                  {current && <span className="version-current">Current</span>}
                  <span className="spacer" />
                  <span className="version-time" title={new Date(v.at).toLocaleString()}>
                    {timeAgo(v.at)}
                  </span>
                </div>
                <p className="version-message">{v.message}</p>
                <p className="version-meta">
                  {v.model ? `${shortModel(v.model.split(":").slice(1).join(":"))} · ` : ""}
                  {v.sha.slice(0, 7)}
                </p>
                {(!current || (onReopen && versionKind(v.message) === "pick")) && (
                  <div className="version-actions">
                    {!current && (
                      <button className="btn btn-secondary btn-sm" onClick={() => onPreview(previewing ? null : v)} aria-pressed={previewing}>
                        {previewing ? "Close preview" : "Preview"}
                      </button>
                    )}
                    {!current && previewing && (
                      <button className="btn btn-primary btn-sm" onClick={onRestore}>
                        Restore
                      </button>
                    )}
                    {onReopen && versionKind(v.message) === "pick" && (
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={busy}
                        title="Show the variants of this pick again, to pick another one"
                        onClick={() => onReopen(v)}
                      >
                        Reopen variants
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
