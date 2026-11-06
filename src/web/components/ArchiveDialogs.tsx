import { useEffect, useRef, useState } from "react";
import { formatSize, runExport } from "../export.ts";
import type { ImportPlan, ImportResult, UiPrefs } from "../../workspace/archive.ts";

/** Export of one project or the whole workspace (#114), with optional settings and UI preferences. */
export function ExportArchiveDialog({ kind, project, projectName, ui, onClose }: {
  kind: "project" | "workspace";
  project?: string;
  projectName?: string;
  /** The UI preferences of this browser, to put into the file when the user wants. */
  ui: UiPrefs;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState(true);
  const [prefs, setPrefs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ file: string; size: number } | null>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await runExport("/api/export", kind === "project" ? `${project}.doi.zip` : "doi-workspace.doi.zip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, ...(project ? { project } : {}), settings, ui: prefs ? ui : null }),
      });
      setDone(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog archive-dialog" role="dialog" aria-modal="true" aria-label="Export" tabIndex={-1} ref={ref}>
        <div className="archive-inner">
          <div className="dialog-head">
            <h2>{kind === "project" ? `Export ${projectName ?? project}` : "Export the workspace"}</h2>
            <span className="spacer" />
            <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)" disabled={busy}>
              ×
            </button>
          </div>
          <div className="archive-body">
            <p className="repo-intro">
              {kind === "project"
                ? "One file with the project's designs, chat, comments, frames, tweaks, its design system and its version history. Import it into any doi workspace."
                : "One file with all projects, all design systems and their version history. Import it into another workspace or keep it as a backup."}
            </p>
            <label className="check-card">
              <input type="checkbox" checked={settings} onChange={(e) => setSettings(e.target.checked)} disabled={busy} />
              <span>
                <span className="check-title">Model choice and prices</span>
                <span className="check-sub">The [models] and [prices] of config.toml. Never API keys or key names.</span>
              </span>
            </label>
            <label className="check-card">
              <input type="checkbox" checked={prefs} onChange={(e) => setPrefs(e.target.checked)} disabled={busy} />
              <span>
                <span className="check-title">UI preferences</span>
                <span className="check-sub">Theme, open panels and the last open design.</span>
              </span>
            </label>
            {busy && (
              <div className="export-progress" role="status">
                <span className="spinner" />
                Packing the files and the history…
              </div>
            )}
            {error && (
              <div className="banner banner-err" role="alert">
                <span className="dot dot-err" />
                {error}
              </div>
            )}
            {done && (
              <p className="export-result-head" role="status">
                <span className="dot dot-ok" />
                <strong>Saved {done.file}</strong>
                <span className="mono muted">{formatSize(done.size)} · in your browser's downloads</span>
              </p>
            )}
          </div>
          <div className="dialog-foot">
            <span className="spacer" />
            {done ? (
              <button className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            ) : (
              <>
                <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={() => void start()} disabled={busy}>
                  Export
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

type Inspected = Pick<ImportPlan, "manifest" | "projects" | "designSystems">;
type Imported = ImportResult & { settingsApplied: boolean; settingsError?: string };

async function postZip<T>(url: string, file: File): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/zip" }, body: file });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

/** Import of an export file: first what it holds and what the import does, then the import. */
export function ImportArchiveDialog({ file, onImported, onClose }: {
  file: File;
  /** The import is done; `ui` when the user chose to use its preferences. */
  onImported: (result: Imported, ui: UiPrefs | null) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [plan, setPlan] = useState<Inspected | null>(null);
  const [settings, setSettings] = useState(false);
  const [prefs, setPrefs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  useEffect(() => {
    let live = true;
    postZip<Inspected>("/api/import/inspect", file)
      .then((p) => live && setPlan(p))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [file]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await postZip<Imported>(`/api/import${settings ? "?settings=1" : ""}`, file);
      onImported(r, prefs ? r.manifest.ui : null);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const m = plan?.manifest;
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog archive-dialog" role="dialog" aria-modal="true" aria-label="Import" tabIndex={-1} ref={ref}>
        <div className="archive-inner">
          <div className="dialog-head">
            <h2>Import</h2>
            <span className="mono muted truncate">{file.name}</span>
            <span className="spacer" />
            <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)" disabled={busy}>
              ×
            </button>
          </div>
          <div className="archive-body">
            {!plan && !error && (
              <div className="export-progress" role="status">
                <span className="spinner" />
                Reading the file…
              </div>
            )}
            {error && (
              <div className="banner banner-err" role="alert">
                <span className="dot dot-err" />
                {error}
              </div>
            )}
            {m && plan && (
              <>
                <p className="repo-intro">
                  {m.kind === "workspace" ? "A workspace export" : "A project export"} from {new Date(m.createdAt).toLocaleString()}
                  {m.history ? ", with its version history." : ", without version history."} Each project comes in as a new project; nothing
                  that is here now changes.
                </p>
                <div className="archive-list">
                  <h4>Projects · {plan.projects.length}</h4>
                  {plan.projects.map((p) => (
                    <p key={p.from}>
                      <strong>{p.name}</strong>
                      <span className="mono muted">{p.to === p.from ? p.to : `${p.from} → ${p.to} (the id is taken here)`}</span>
                    </p>
                  ))}
                  {plan.designSystems.length > 0 && <h4>Design systems · {plan.designSystems.length}</h4>}
                  {plan.designSystems.map((d) => (
                    <p key={d.from}>
                      <strong className="mono">{d.to}</strong>
                      <span className="muted">
                        {d.reused ? "already here with the same files: reused" : d.to === d.from ? "new" : `renamed from ${d.from}: one with that name and other files is here`}
                      </span>
                    </p>
                  ))}
                </div>
                {m.settings && (
                  <label className="check-card">
                    <input type="checkbox" checked={settings} onChange={(e) => setSettings(e.target.checked)} disabled={busy} />
                    <span>
                      <span className="check-title">Use its model choice and prices</span>
                      <span className="check-sub mono">
                        generate {m.settings.models.generate} · edit {m.settings.models.edit} · extract {m.settings.models.extract}
                        {Object.keys(m.settings.prices).length ? ` · ${Object.keys(m.settings.prices).length} prices` : ""}
                      </span>
                    </span>
                  </label>
                )}
                {m.ui && (
                  <label className="check-card">
                    <input type="checkbox" checked={prefs} onChange={(e) => setPrefs(e.target.checked)} disabled={busy} />
                    <span>
                      <span className="check-title">Use its UI preferences</span>
                      <span className="check-sub">
                        Theme {m.ui.theme ?? "system"}
                        {m.ui.panels ? ` · chat ${m.ui.panels.chat ? "open" : "closed"}, side panel ${m.ui.panels.side ? "open" : "closed"}` : ""}
                        {m.ui.lastDesign ? " · opens its last design" : ""}
                      </span>
                    </span>
                  </label>
                )}
              </>
            )}
            {busy && (
              <div className="export-progress" role="status">
                <span className="spinner" />
                Importing the files and the history…
              </div>
            )}
          </div>
          <div className="dialog-foot">
            <span className="spacer" />
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={() => void start()} disabled={!plan || busy}>
              Import
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
