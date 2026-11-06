import { useEffect, useState } from "react";
import { getJSON, type Load } from "../api.ts";
import type { GhStatus, RepoSummary } from "../../github/gh.ts";

const REPO_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

/** The gh login state and the user's repos, through the server's `gh` routes only. */
export function useGithub() {
  const [status, setStatus] = useState<Load<GhStatus>>({ state: "loading" });
  const [repos, setRepos] = useState<Load<RepoSummary[]>>({ state: "loading" });
  const [checks, setChecks] = useState(0);
  useEffect(() => {
    let live = true;
    setStatus({ state: "loading" });
    getJSON<GhStatus>("/api/github/status")
      .then((s) => {
        if (!live) return;
        setStatus({ state: "ready", data: s });
        if (!s.loggedIn) return;
        setRepos({ state: "loading" });
        getJSON<RepoSummary[]>("/api/github/repos")
          .then((data) => live && setRepos({ state: "ready", data }))
          .catch((e: Error) => live && setRepos({ state: "error", message: e.message }));
      })
      .catch((e: Error) => live && setStatus({ state: "error", message: e.message }));
    return () => {
      live = false;
    };
  }, [checks]);
  return { status, repos, gh: status.state === "ready" ? status.data : null, recheck: () => setChecks((n) => n + 1) };
}

/** The list of repos to link, with the messages for a missing or logged-out gh. */
export function RepoPicker({ github, busy, linked, onPick, autoFocus = false }: {
  github: ReturnType<typeof useGithub>;
  busy: boolean;
  linked: string | null;
  onPick: (name: string) => void;
  autoFocus?: boolean;
}) {
  const { status, repos, gh } = github;
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const list = repos.state === "ready" ? repos.data.filter((r) => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)) : [];
  // A full name that is not in the list (another owner, an organization) can be linked too.
  const typed = REPO_NAME.test(filter.trim()) && !list.some((r) => r.name.toLowerCase() === q) ? filter.trim() : null;
  return (
    <>
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
        <button className="btn btn-secondary btn-sm" onClick={() => github.recheck()}>
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
        <button className="btn btn-secondary btn-sm" onClick={() => github.recheck()}>
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
          autoFocus={autoFocus}
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
              <button className="btn btn-primary btn-md" disabled={busy} onClick={() => onPick(typed)}>
                Link
              </button>
            </div>
          )}
          {list.map((r) => {
            const current = linked?.toLowerCase() === r.name.toLowerCase();
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
                  <button className="btn btn-secondary btn-md" disabled={busy} onClick={() => onPick(r.name)}>
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
    </>
  );
}
