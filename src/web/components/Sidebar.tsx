import type { Load, ProjectSummary } from "../api.ts";
import { Icon } from "./Icon.tsx";

export interface Active {
  project: string;
  design: string;
}

export function Sidebar({ projects, active, workspace, onOpen, onRetry }: {
  projects: Load<ProjectSummary[]>;
  active: Active | null;
  workspace: string | null;
  onOpen: (a: Active) => void;
  onRetry: () => void;
}) {
  return (
    <nav className="sidebar" aria-label="Projects">
      <div className="panel-header">
        <span className="panel-title">Projects</span>
        <button className="icon-btn" disabled title="New project arrives with #12" aria-label="New project">
          <Icon name="plus" />
        </button>
      </div>

      <div className="sidebar-body">
        {projects.state === "loading" && (
          <div className="skeleton-list" aria-busy="true" aria-label="Loading projects">
            <div className="skeleton" style={{ width: "60%" }} />
            <div className="skeleton skeleton-indent" style={{ width: "45%" }} />
            <div className="skeleton skeleton-indent" style={{ width: "52%" }} />
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

        {projects.state === "ready" && projects.data.length === 0 && (
          <div className="empty-small">
            <p>No projects yet.</p>
            <p className="muted">Projects are folders in <code>workspace/projects</code>.</p>
          </div>
        )}

        {projects.state === "ready" &&
          projects.data.map((p) => (
            <div key={p.id} className="tree-group">
              <div className="tree-row tree-project">
                <Icon name="chevron" className="tree-chevron is-open" size={12} />
                <Icon name="folder" />
                <span className="tree-label">{p.name}</span>
              </div>
              {p.designs.length === 0 && <div className="tree-row tree-design muted">No designs</div>}
              {p.designs.map((d) => {
                const isActive = active?.project === p.id && active.design === d;
                return (
                  <button
                    key={d}
                    className={`tree-row tree-design ${isActive ? "is-active" : ""}`}
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => onOpen({ project: p.id, design: d })}
                  >
                    <Icon name="frame" />
                    <span className="tree-label">{d}</span>
                  </button>
                );
              })}
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
