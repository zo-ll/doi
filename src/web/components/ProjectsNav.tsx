import { useEffect, useRef, useState } from "react";
import { sendJSON, type Active, type Load, type ProjectSummary } from "../api.ts";

/** What the inline editor is open for, if anything. */
type Editing =
  | { kind: "new-project" }
  | { kind: "rename-project"; project: string }
  | { kind: "new-design"; project: string; slides: boolean }
  | { kind: "rename-design"; project: string; design: string };

export interface WorkspaceState {
  path: string;
  /** Uncommitted files, or null without git. */
  changes: number | null;
}

const NAME_HINT = "a-z, 0-9 and -";

/** A text field that saves on Enter and cancels on Esc or blur. It shows the server's error. */
function InlineInput({ initial, label, placeholder, project, onSubmit, onCancel }: {
  initial: string;
  label: string;
  placeholder: string;
  /** A project row is indented less than a design row. */
  project?: boolean;
  /** Resolves when saved; rejects with the message to show. */
  onSubmit: (value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const submit = async () => {
    const v = value.trim();
    if (!v || busy) return;
    if (v === initial) return onCancel();
    setBusy(true);
    try {
      await onSubmit(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className={`nav-edit ${project ? "is-project" : ""}`}>
      <input
        ref={ref}
        value={value}
        aria-label={label}
        placeholder={placeholder}
        disabled={busy}
        aria-invalid={error !== null}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation(); // Esc closes the field, not the drawer
            onCancel();
          }
        }}
        onBlur={() => {
          if (!busy && error === null) onCancel();
        }}
      />
      {error && <p className="nav-edit-error" role="alert">{error}</p>}
    </div>
  );
}

/** The projects drawer (⌘P): it opens over the chat, so navigation never takes canvas width. */
export function ProjectsNav({ projects, active, workspace, onOpen, onRetry, onChanged, onClose, onExport, onImport }: {
  projects: Load<ProjectSummary[]>;
  active: Active | null;
  workspace: Load<WorkspaceState>;
  onOpen: (a: Active) => void;
  onRetry: () => void;
  /** The project list changed; `open` is the design to open next, if any. */
  onChanged: (open?: Active) => void;
  onClose: () => void;
  /** Export one project to a file. */
  onExport: (project: string) => void;
  /** Pick an export file to import. */
  onImport: () => void;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  // Projects start open; the user can fold them.
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const close = () => setEditing(null);
  const toggle = (id: string) =>
    setFolded((f) => {
      const next = new Set(f);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const createProject = async (name: string) => {
    const r = await sendJSON<{ id: string; design: string }>("POST", "/api/projects", { name });
    close();
    onChanged({ project: r.id, design: r.design });
  };
  const renameProject = async (project: string, name: string) => {
    await sendJSON("PATCH", `/api/projects/${project}`, { name });
    close();
    onChanged();
  };
  const createDesign = async (project: string, id: string, slides: boolean) => {
    await sendJSON("POST", `/api/projects/${project}/designs`, { id, kind: slides ? "slides" : "page" });
    close();
    onChanged({ project, design: id });
  };
  const renameDesign = async (project: string, design: string, id: string) => {
    await sendJSON("PATCH", `/api/projects/${project}/designs/${design}`, { id });
    close();
    const wasOpen = active?.project === project && active.design === design;
    onChanged(wasOpen ? { project, design: id } : undefined);
  };
  const is = (e: Editing) => JSON.stringify(e) === JSON.stringify(editing);

  const list = projects.state === "ready" ? projects.data : [];
  const empty = projects.state === "ready" && list.length === 0 && editing?.kind !== "new-project";

  return (
    <>
      <div className="nav-layer" onMouseDown={onClose} />
      <div className="nav-drawer" role="dialog" aria-label="Projects">
        <div className="panel-header">
          <span className="panel-title">Projects</span>
          <span className="spacer" />
          {!empty && (
            <button className="btn btn-secondary btn-md" onClick={() => setEditing({ kind: "new-project" })}>
              New project
            </button>
          )}
        </div>

        <div className="nav-body">
          {editing?.kind === "new-project" && (
            <InlineInput project initial="" label="New project name" placeholder="Project name" onSubmit={createProject} onCancel={close} />
          )}

          {projects.state === "loading" && (
            <div aria-busy="true" aria-label="Loading projects">
              <div className="nav-skeleton">
                <div className="skeleton" />
                <div className="skeleton" />
                <div className="skeleton" />
                <div className="skeleton" />
              </div>
              <p className="status nav-empty">
                <span className="spinner" />
                Reading the workspace…
              </p>
            </div>
          )}

          {projects.state === "error" && (
            <div className="banner banner-err" role="alert">
              <span className="dot dot-err" />
              <div>
                <p className="banner-title">Cannot read the workspace</p>
                <p>{projects.message}</p>
                <button className="btn btn-secondary btn-sm" onClick={onRetry}>
                  Retry
                </button>
              </div>
            </div>
          )}

          {empty && (
            <div className="nav-state">
              <h3>No projects yet</h3>
              <p>A project groups designs and can use one design system. doi stores it as a folder in your workspace.</p>
              <div>
                <button className="btn btn-primary" onClick={() => setEditing({ kind: "new-project" })}>
                  Create project
                </button>
              </div>
            </div>
          )}

          {list.map((p) => {
            const open = !folded.has(p.id);
            const addingHere = editing?.kind === "new-design" && editing.project === p.id;
            return (
              <div key={p.id} className="nav-project">
                {is({ kind: "rename-project", project: p.id }) ? (
                  <InlineInput
                    project
                    initial={p.name}
                    label={`New name for project ${p.name}`}
                    placeholder="Project name"
                    onSubmit={(name) => renameProject(p.id, name)}
                    onCancel={close}
                  />
                ) : (
                  <div className="nav-row">
                    <button
                      className="nav-caret"
                      aria-expanded={open}
                      aria-label={`${open ? "Fold" : "Unfold"} ${p.name}`}
                      onClick={() => toggle(p.id)}
                    >
                      {open ? "▼" : "▶"}
                    </button>
                    <span
                      className="nav-project-name"
                      title="Double-click to rename"
                      onDoubleClick={() => setEditing({ kind: "rename-project", project: p.id })}
                    >
                      {p.name}
                    </span>
                    <button className="btn btn-ghost btn-sm nav-export" onClick={() => onExport(p.id)} title={`Export ${p.name} to a file`}>
                      Export
                    </button>
                    <span className="nav-count">{p.designs.length}</span>
                  </div>
                )}
                {open && (
                  <>
                    {p.designs.map((d) => {
                      if (is({ kind: "rename-design", project: p.id, design: d })) {
                        return (
                          <InlineInput
                            key={d}
                            initial={d}
                            label={`New name for design ${d}`}
                            placeholder={NAME_HINT}
                            onSubmit={(id) => renameDesign(p.id, d, id)}
                            onCancel={close}
                          />
                        );
                      }
                      const current = active?.project === p.id && active.design === d;
                      const deck = p.decks.includes(d);
                      return (
                        <button
                          key={d}
                          className="nav-design"
                          aria-current={current ? "page" : undefined}
                          title="Double-click or F2 to rename"
                          onClick={() => {
                            onOpen({ project: p.id, design: d });
                            onClose();
                          }}
                          onDoubleClick={() => setEditing({ kind: "rename-design", project: p.id, design: d })}
                          onKeyDown={(e) => e.key === "F2" && setEditing({ kind: "rename-design", project: p.id, design: d })}
                        >
                          <span className={`nav-design-icon ${deck ? "is-deck" : ""}`} aria-hidden="true" />
                          <span className="nav-design-name">{d}</span>
                          {deck && <span className="visually-hidden">(slide deck)</span>}
                        </button>
                      );
                    })}
                    {p.designs.length === 0 && !addingHere && <div className="nav-empty">No designs yet</div>}
                    {addingHere && (
                      <InlineInput
                        key={String(editing.slides)}
                        initial=""
                        label={editing.slides ? `New slide deck name in ${p.name}` : `New design name in ${p.name}`}
                        placeholder={NAME_HINT}
                        onSubmit={(id) => createDesign(p.id, id, editing.slides)}
                        onCancel={close}
                      />
                    )}
                    <div className="nav-adds">
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing({ kind: "new-design", project: p.id, slides: false })}>
                        + Design
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing({ kind: "new-design", project: p.id, slides: true })}>
                        + Slide deck
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {workspace.state === "ready" && (
          <div className="nav-footer">
            <div className="nav-footer-head">
              <span>Workspace</span>
              <button className="link-btn" onClick={onImport} title="Import a project or a workspace from an export file">
                Import…
              </button>
              <span className="status">
                <span className={`dot ${workspace.data.changes === null ? "" : workspace.data.changes === 0 ? "dot-ok" : "dot-warn"}`} />
                {workspace.data.changes === null
                  ? "git · off"
                  : workspace.data.changes === 0
                    ? "git · clean"
                    : `git · ${workspace.data.changes} uncommitted`}
              </span>
            </div>
            <div className="nav-footer-path truncate" title={workspace.data.path}>
              {workspace.data.path}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
