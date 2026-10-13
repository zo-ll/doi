import type { AppConfig, Harnesses, Load } from "../api.ts";
import { Icon } from "./Icon.tsx";

const HARNESS_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  "gemini-cli": "Gemini CLI",
  aider: "Aider",
};

export function TopBar({ project, design, config, harnesses, designSystem, onDesignSystem, onExport }: {
  project: string | null;
  /** The project's design system; undefined without a project. */
  designSystem?: string | null;
  onDesignSystem?: () => void;
  /** Opens the export dialog; undefined without an open design. */
  onExport?: () => void;
  design: string | null;
  config: Load<AppConfig>;
  harnesses: Load<Harnesses>;
}) {
  const harnessId = config.state === "ready" ? config.data.harness.default : null;
  const harnessFound = harnessId && harnesses.state === "ready" ? harnesses.data[harnessId] : undefined;

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
        {harnessId && (
          <span
            className="pill"
            title={harnessFound === false ? "Not found on PATH" : "Default harness (config.toml → harness.default)"}
          >
            <span className={`status-dot ${harnessFound === false ? "is-off" : harnessFound ? "is-on" : ""}`} />
            {HARNESS_LABEL[harnessId] ?? harnessId}
          </span>
        )}
        {onExport && (
          <button className="btn btn-secondary" onClick={onExport} title="Download the design as a folder or one HTML file">
            <Icon name="download" size={14} />
            Export
          </button>
        )}
        <button className="btn btn-secondary" disabled title="Handoff arrives in M4">
          <Icon name="handoff" size={14} />
          Hand off
        </button>
      </div>
    </header>
  );
}
