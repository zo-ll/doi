import type { Load, VersionView } from "../api.ts";
import { Icon } from "./Icon.tsx";

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

export function HistoryPanel({ versions, preview, onPreview, onRetry }: {
  versions: Load<VersionView[]>;
  /** The version shown in the preview frame. */
  preview: string | null;
  onPreview: (v: VersionView | null) => void;
  onRetry: () => void;
}) {
  return (
    <div className="comments history">
      <div className="comments-list">
        {versions.state === "loading" && <div className="skeleton comments-skeleton" aria-label="Loading the history" />}
        {versions.state === "error" && (
          <div className="notice notice-danger" role="alert">
            <Icon name="alert" />
            <span>The history cannot load: {versions.message}</span>
            <button className="link-btn" onClick={onRetry}>Try again</button>
          </div>
        )}
        {versions.state === "ready" && versions.data.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-icon"><Icon name="history" size={20} /></div>
            <h2>No versions</h2>
            <p>Each completed change is a version here. Preview an old version, and restore it if you want it back.</p>
          </div>
        )}
        {versions.state === "ready" &&
          versions.data.map((v, i) => (
            <button
              key={v.sha}
              className={`version${preview === v.sha ? " is-active" : ""}`}
              onClick={() => onPreview(preview === v.sha || i === 0 ? null : v)}
              aria-pressed={preview === v.sha}
              title={i === 0 ? "This is the current version" : "Preview this version on the canvas"}
            >
              <span className="version-message">{v.message}</span>
              <span className="version-meta">
                <span>{timeAgo(v.at)}</span>
                {v.model && <span className="truncate">{v.model}</span>}
                <span className="version-sha">{v.sha.slice(0, 7)}</span>
                {i === 0 && <span className="badge-current">Current</span>}
              </span>
            </button>
          ))}
      </div>
    </div>
  );
}
