import { useEffect, useRef, useState } from "react";
import { sendJSON, type ProjectSummary } from "../api.ts";
import { RepoPicker, useGithub } from "./RepoPicker.tsx";
import { timeAgo } from "./HistoryPanel.tsx";

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
  const github = useGithub();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const linked = project.repo;

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

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

  const gh = github.gh;

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

            <RepoPicker github={github} busy={!!busy} linked={linked?.name ?? null} onPick={(name) => void link(name)} autoFocus />
          </div>
          <div className="dialog-foot">
            <span className="muted">doi makes a shallow copy in the workspace. It never changes the repo and never reads your gh token.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
