import { useEffect, useRef, useState } from "react";
import { getJSON, sendJSON, type Load, type ProjectSummary } from "../api.ts";
import type { GhStatus, RepoSummary } from "../../github/gh.ts";
import { timeAgo } from "./HistoryPanel.tsx";

const REPO_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

/**
 * The app's code (#112): link one GitHub repo to the project through the gh CLI. The model
 * then reads the code when it makes or changes a design of this project.
 */
export function RepoDialog({ project, onChanged, onClose }: {
  project: ProjectSummary;
  /** The link changed: the project list loads again. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Load<GhStatus>>({ state: "loading" });
  const [repos, setRepos] = useState<Load<RepoSummary[]>>({ state: "loading" });
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState(0);
  const linked = project.repo;

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  useEffect(() => {
    setStatus({ state: "loading" });
    getJSON<GhStatus>("/api/github/status")
      .then((s) => {
        setStatus({ state: "ready", data: s });
        if (!s.loggedIn) return;
        setRepos({ state: "loading" });
        getJSON<RepoSummary[]>("/api/github/repos")
          .then((data) => setRepos({ state: "ready", data }))
          .catch((e: Error) => setRepos({ state: "error", message: e.message }));
      })
      .catch((e: Error) => setStatus({ state: "error", message: e.message }));
  }, [checks]);

  const run = async (label: string, job: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await job();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const link = (name: string) => run(`Cloning ${name}…`, () => sendJSON("PUT", `/api/projects/${project.id}/repo`, { name }));
  const sync = () => run(`Updating ${linked?.name}…`, () => sendJSON("POST", `/api/projects/${project.id}/repo/sync`));
  const unlink = () => run("Unlinking…", () => sendJSON("DELETE", `/api/projects/${project.id}/repo`));

  const q = filter.trim().toLowerCase();
  const list = repos.state === "ready" ? repos.data.filter((r) => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)) : [];
  // A full name that is not in the list (another owner, an organization) can be linked too.
  const typed = REPO_NAME.test(filter.trim()) && !list.some((r) => r.name.toLowerCase() === q) ? filter.trim() : null;
  const gh = status.state === "ready" ? status.data : null;

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog repo-dialog" role="dialog" aria-modal="true" aria-label="The app's code" tabIndex={-1} ref={ref}>
        <div className="repo-inner">
          <div className="dialog-head">
            <h2>The app's code</h2>
            <span className="muted">{project.name}</span>
            <span className="spacer" />
            <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)" disabled={!!busy}>
              ×
            </button>
          </div>
          <div className="repo-body">
            <p className="repo-intro">
              Link the GitHub repo of the app that this project designs. The model then reads its code when it makes a design, so you can ask
              in chat: "Recreate the settings page" or "Make our pricing page calmer".
            </p>

            {linked && (
              <div className="repo-linked">
                <span className="dot dot-ok" />
                <div className="repo-linked-text">
                  <strong className="mono">{linked.name}</strong>
                  <span className="muted mono">
                    {linked.commit.slice(0, 7)} · updated {linked.syncedAt ? timeAgo(linked.syncedAt) : "–"}
                  </span>
                </div>
                <span className="spacer" />
                <button className="btn btn-secondary btn-md" disabled={!!busy || !gh?.loggedIn} onClick={() => void sync()} title="Fetch the latest commit of the default branch">
                  Update
                </button>
                <button className="btn btn-ghost btn-md" disabled={!!busy} onClick={() => void unlink()}>
                  Unlink
                </button>
              </div>
            )}

            {busy && (
              <div className="export-progress" role="status">
                <span className="spinner" />
                {busy}
              </div>
            )}
            {error && (
              <div className="banner banner-err" role="alert">
                <span className="dot dot-err" />
                {error}
              </div>
            )}

            {status.state === "loading" && <div className="skeleton comment-skeleton" aria-label="Checking gh" />}
            {gh && !gh.installed && (
              <div className="banner banner-warn" role="status">
                <span className="dot dot-warn" />
                <div className="spacer">
                  <p className="banner-title">The GitHub CLI is not installed</p>
                  <p>
                    doi reaches GitHub only through the official <span className="mono">gh</span> CLI. Install it from cli.github.com, log in with{" "}
                    <span className="mono">gh auth login</span>, then check again.
                  </p>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => setChecks((n) => n + 1)}>
                  Check again
                </button>
              </div>
            )}
            {gh && gh.installed && !gh.loggedIn && (
              <div className="banner banner-warn" role="status">
                <span className="dot dot-warn" />
                <div className="spacer">
                  <p className="banner-title">gh is not logged in</p>
                  <p>
                    Run <span className="mono">gh auth login</span> in a terminal, then check again. doi never sees your GitHub token.
                  </p>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => setChecks((n) => n + 1)}>
                  Check again
                </button>
              </div>
            )}

            {gh?.loggedIn && (
              <>
                <input
                  className="input"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter your repos, or type owner/repo"
                  aria-label="Filter repos"
                  spellCheck={false}
                  autoFocus
                />
                <div className="repo-list">
                  {repos.state === "loading" && <div className="skeleton comment-skeleton" aria-label="Loading your repos" />}
                  {repos.state === "error" && <p className="field-error">{repos.message}</p>}
                  {typed && (
                    <div className="repo-row">
                      <div className="repo-row-text">
                        <strong className="mono">{typed}</strong>
                        <span className="muted">A repo of another owner or an organization</span>
                      </div>
                      <button className="btn btn-primary btn-md" disabled={!!busy} onClick={() => void link(typed)}>
                        Link
                      </button>
                    </div>
                  )}
                  {list.map((r) => {
                    const current = linked?.name.toLowerCase() === r.name.toLowerCase();
                    return (
                      <div key={r.name} className="repo-row">
                        <div className="repo-row-text">
                          <strong className="mono truncate">{r.name}</strong>
                          <span className="muted truncate">
                            {[r.private ? "Private" : "Public", r.language, r.description].filter(Boolean).join(" · ")}
                          </span>
                        </div>
                        {current ? (
                          <span className="status">
                            <span className="dot dot-ok" />
                            Linked
                          </span>
                        ) : (
                          <button className="btn btn-secondary btn-md" disabled={!!busy} onClick={() => void link(r.name)}>
                            {linked ? "Link instead" : "Link"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {repos.state === "ready" && !list.length && !typed && <p className="comments-empty">No repo matches.</p>}
                </div>
              </>
            )}
          </div>
          <div className="dialog-foot">
            <span className="muted">doi makes a shallow copy in the workspace. It never changes the repo and never reads your gh token.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
