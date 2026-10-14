import { Icon } from "./Icon.tsx";

export function TopBar({ project, design, designSystem, onDesignSystem, onExport, onHandoff }: {
  project: string | null;
  /** The project's design system; undefined without a project. */
  designSystem?: string | null;
  onDesignSystem?: () => void;
  /** Opens the export dialog; undefined without an open design. */
  onExport?: () => void;
  /** Opens the export dialog at the agent prompt; undefined without an open design. */
  onHandoff?: () => void;
  design: string | null;
}) {
  return (
    <header className="topbar">
      <div className="topbar-start">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true" />
          doi
        </span>
        {project && (
          <nav className="crumbs" aria-label="Current design">
            <span className="crumb">{project}</span>
            <span className="crumb-sep">/</span>
            <span className="crumb crumb-current">{design ?? "No design"}</span>
          </nav>
        )}
      </div>
      <div className="topbar-end">
        {project && designSystem !== undefined && (
          <button className="btn btn-secondary" onClick={onDesignSystem} title="Choose or import the design system of this project">
            <Icon name="palette" size={14} />
            {designSystem ?? "No design system"}
          </button>
        )}
        {onExport && (
          <button className="btn btn-secondary" onClick={onExport} title="Download the design as a folder or one HTML file">
            <Icon name="download" size={14} />
            Export
          </button>
        )}
        <button
          className="btn btn-secondary"
          onClick={onHandoff}
          disabled={!onHandoff}
          title="Give the design to a coding agent: a prompt for the doi MCP server, or a ZIP bundle"
        >
          <Icon name="handoff" size={14} />
          Hand off
        </button>
      </div>
    </header>
  );
}
