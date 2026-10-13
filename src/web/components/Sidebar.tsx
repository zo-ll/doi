import { useEffect, useRef, useState } from "react";
import { sendJSON, type Load, type ProjectSummary } from "../api.ts";
import { Icon } from "./Icon.tsx";

export interface Active {
  project: string;
  design: string;
}

/** What the inline editor is open for, if anything. */
type Editing =
  | { kind: "new-project" }
  | { kind: "rename-project"; project: string }
  | { kind: "new-design"; project: string; slides: boolean }
  | { kind: "rename-design"; project: string; design: string };

const NAME_HINT = "a-z, 0-9 and -";

/** A text field that saves on Enter and cancels on Esc or blur. It shows the server's error. */
function InlineInput({ initial, label, placeholder, onSubmit, onCancel }: {
  initial: string;
  label: string;
  placeholder: string;
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
    <div className="tree-edit">
      <input
        ref={ref}
        value={value}
        aria-label={label}
        placeholder={placeholder}
        disabled={busy}
        aria-invalid={error !== null}
        onChange={(e) => { setValue(e.target.value); setError(null); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void submit(); }
          else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        onBlur={() => { if (!busy && error === null) onCancel(); }}
      />
      {error && <p className="tree-edit-error" role="alert">{error}</p>}
    </div>
  );
}

export function Sidebar({ projects, active, workspace, onOpen, onRetry, onChanged }: {
  projects: Load<ProjectSummary[]>;
  active: Active | null;
  workspace: string | null;
  onOpen: (a: Active) => void;
  onRetry: () => void;
  /** The project list changed; `open` is the design to open next, if any. */
  onChanged: (open?: Active) => void;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const close = () => setEditing(null);

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

  return (
    <nav className="sidebar" aria-label="Projects">
      <div className="panel-header">
        <span className="panel-title">Projects</span>
        <button className="icon-btn" title="New project" aria-label="New project" onClick={() => setEditing({ kind: "new-project" })}>
          <Icon name="plus" />
        </button>
      </div>

      <div className="sidebar-body">
        {editing?.kind === "new-project" && (
          <InlineInput initial="" label="New project name" placeholder="Project name" onSubmit={createProject} onCancel={close} />
        )}

        {projects.state === "loading" && (
          <div className="skeleton-list" aria-busy="true" aria-label="Loading projects">
            <div className="skeleton" />
            <div className="skeleton skeleton-indent" />
            <div className="skeleton skeleton-indent" />
          </div>
        )}

        {projects.state === "error" && (
          <div className="notice notice-danger">
            <Icon name="alert" />
            <div>
              <p className="notice-title">Cannot load projects</p>
              <p className="notice-text">{projects.message}</p>
              <button className="link-btn" onClick={onRetry}>Retry</button>
            </div>
          </div>
        )}

        {projects.state === "ready" && projects.data.length === 0 && !editing && (
          <div className="empty-small">
            <p>No projects yet.</p>
            <button className="link-btn" onClick={() => setEditing({ kind: "new-project" })}>Create a project</button>
          </div>
        )}

        {projects.state === "ready" &&
          projects.data.map((p) => (
            <div key={p.id} className="tree-group">
              {is({ kind: "rename-project", project: p.id }) ? (
                <InlineInput
                  initial={p.name}
                  label={`New name for project ${p.name}`}
                  placeholder="Project name"
                  onSubmit={(name) => renameProject(p.id, name)}
                  onCancel={close}
                />
              ) : (
                <div className="tree-row tree-project">
                  <Icon name="chevron" className="tree-chevron is-open" size={12} />
                  <Icon name="folder" />
                  <span
                    className="tree-label"
                    title="Double-click to rename"
                    onDoubleClick={() => setEditing({ kind: "rename-project", project: p.id })}
                  >
                    {p.name}
                  </span>
                  <button
                    className="icon-btn tree-action"
                    title="New design"
                    aria-label={`New design in ${p.name}`}
                    onClick={() => setEditing({ kind: "new-design", project: p.id, slides: false })}
                  >
                    <Icon name="plus" size={14} />
                  </button>
                  <button
                    className="icon-btn tree-action"
                    title="New slide deck"
                    aria-label={`New slide deck in ${p.name}`}
                    onClick={() => setEditing({ kind: "new-design", project: p.id, slides: true })}
                  >
                    <Icon name="slides" size={14} />
                  </button>
                </div>
              )}
              {p.designs.length === 0 && !(editing?.kind === "new-design" && editing.project === p.id) && (
                <div className="tree-row tree-design muted">No designs</div>
              )}
              {p.designs.map((d) => {
                if (is({ kind: "rename-design", project: p.id, design: d })) {
                  return (
                    <div key={d} className="tree-indent">
                      <InlineInput
                        initial={d}
                        label={`New name for design ${d}`}
                        placeholder={NAME_HINT}
                        onSubmit={(id) => renameDesign(p.id, d, id)}
                        onCancel={close}
                      />
                    </div>
                  );
                }
                const isActive = active?.project === p.id && active.design === d;
                return (
                  <button
                    key={d}
                    className={`tree-row tree-design ${isActive ? "is-active" : ""}`}
                    aria-current={isActive ? "page" : undefined}
                    title="Double-click or F2 to rename"
                    onClick={() => onOpen({ project: p.id, design: d })}
                    onDoubleClick={() => setEditing({ kind: "rename-design", project: p.id, design: d })}
                    onKeyDown={(e) => e.key === "F2" && setEditing({ kind: "rename-design", project: p.id, design: d })}
                  >
                    <Icon name="frame" />
                    <span className="tree-label">{d}</span>
                  </button>
                );
              })}
              {editing?.kind === "new-design" && editing.project === p.id && (
                <div className="tree-indent">
                  <InlineInput
                    key={String(editing.slides)}
                    initial=""
                    label={editing.slides ? `New slide deck name in ${p.name}` : `New design name in ${p.name}`}
                    placeholder={NAME_HINT}
                    onSubmit={(id) => createDesign(p.id, id, editing.slides)}
                    onCancel={close}
                  />
                </div>
              )}
            </div>
          ))}
      </div>

      {workspace && (
        <div className="sidebar-footer" title={workspace}>
          <span className="muted">Workspace</span>
          <code className="truncate">{workspace}</code>
        </div>
      )}
    </nav>
  );
}
