import { useEffect, useState } from "react";
import { TASKS, type TaskStatus } from "../providers.ts";
import type { Theme } from "../theme.ts";

const TONE_DOT = { ok: "dot-ok", warn: "dot-warn", err: "dot-err", unknown: "" } as const;
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** The modifier key as the user's keyboard shows it. */
export const MOD = isMac ? "⌘" : "Ctrl+";

export interface DesignSystemChip {
  name: string;
  /** Up to three colors of the system, for the chip. */
  swatches: string[];
}

export function TopBar(props: {
  projectName: string | null;
  design: string | null;
  isDeck: boolean;
  pages: string[];
  page: string;
  onPage: (page: string) => void;
  /** The count of versions of the open design; null while unknown. */
  version: number | null;
  /** A turn or a variant set runs: the design is not saved yet. */
  busy: boolean;
  navOpen: boolean;
  onNav: () => void;
  /** The project's design system; undefined without a project. */
  designSystem?: DesignSystemChip | null;
  onDesignSystem?: () => void;
  /** The project's linked repo; undefined without a project. */
  repo?: string | null;
  onRepo?: () => void;
  tweaksOpen: boolean;
  onTweaks?: () => void;
  onExport?: () => void;
  onHandoff?: () => void;
  tasks: TaskStatus[];
  onUsage: () => void;
  onSettings: () => void;
  theme: Theme;
  onTheme: () => void;
}) {
  const { projectName, design, tasks } = props;
  const [menu, setMenu] = useState<null | "pages" | "providers">(null);
  const close = () => setMenu(null);
  // Esc closes an open menu first; the app's own Esc (clear the selection) waits for the next press.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setMenu(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menu]);
  const attention = tasks.find((t) => t.tone === "err" || t.tone === "warn");

  return (
    <header className="topbar">
      <button className="brand-btn" onClick={props.onNav} title={`Projects (${MOD}P)`} aria-label="Projects and designs" aria-expanded={props.navOpen}>
        <span className="brand">
          doi<span className="brand-mark" />
        </span>
        <span className="caret">▾</span>
      </button>
      <span className="sep" />
      {projectName && (
        <nav className="crumbs" aria-label="Current design">
          <button className="crumb truncate" onClick={props.onNav}>
            {projectName}
          </button>
          <span className="crumb-sep">/</span>
          <button className="crumb crumb-current truncate" onClick={props.onNav}>
            {design ?? "No design"}
          </button>
          {props.isDeck && <span className="badge">Slide deck</span>}
          {design && (
            <>
              <span className="crumb-sep">/</span>
              <button
                className="crumb crumb-page"
                title="Pages in this design"
                aria-haspopup="menu"
                aria-expanded={menu === "pages"}
                onClick={() => setMenu(menu === "pages" ? null : "pages")}
              >
                {props.page} <span className="caret">▾</span>
              </button>
            </>
          )}
        </nav>
      )}
      {design && props.version !== null && (
        <span className="version-label">
          {props.version === 0 ? (props.busy ? "working…" : "no versions yet") : props.busy ? `v${props.version} · working…` : `v${props.version} · saved`}
        </span>
      )}
      <span className="spacer" />

      {props.designSystem !== undefined && (
        <button
          className={`ds-chip ${props.designSystem ? "" : "is-empty"}`}
          onClick={props.onDesignSystem}
          title={`Design system (${MOD}D)`}
        >
          {props.designSystem && props.designSystem.swatches.length > 0 && (
            <span className="ds-swatches" aria-hidden="true">
              {props.designSystem.swatches.map((c, i) => (
                <span key={i} style={{ background: c }} />
              ))}
            </span>
          )}
          <span className="truncate">{props.designSystem?.name ?? "No design system"}</span>
        </button>
      )}
      {props.repo !== undefined && (
        <button className={`ds-chip ${props.repo ? "" : "is-empty"}`} onClick={props.onRepo} title="The app's code: a GitHub repo the model reads">
          <span className="repo-mark" aria-hidden="true" />
          <span className="truncate">{props.repo ?? "Link the app's repo"}</span>
        </button>
      )}
      {props.onTweaks && (
        <button className="btn btn-ghost" onClick={props.onTweaks} aria-pressed={props.tweaksOpen} title="Tweaks (T)">
          Tweaks
        </button>
      )}
      <span className="sep" />
      <button className="btn btn-secondary" onClick={props.onExport} disabled={!props.onExport} title={`Export (${MOD}E)`}>
        Export
      </button>
      <button className="btn btn-primary" onClick={props.onHandoff} disabled={!props.onHandoff} title={`Hand off to a coding agent (${MOD}⇧H)`}>
        Hand off
      </button>
      <span className="sep" />
      <button
        className="btn btn-ghost"
        onClick={() => setMenu(menu === "providers" ? null : "providers")}
        aria-expanded={menu === "providers"}
        title="Model and provider per task"
        aria-label={attention ? `Models: ${TASKS.find((t) => t.id === attention.task)?.label} is ${attention.label.toLowerCase()}` : "Models"}
      >
        <span className="model-dots" aria-hidden="true">
          {tasks.map((t) => (
            <span key={t.task} className={`dot ${TONE_DOT[t.tone]}`} />
          ))}
        </span>
        <span className="topbar-label">Models</span>
      </button>
      <button className="btn btn-ghost" onClick={props.onUsage} title="Usage">
        Usage
      </button>
      <button className="btn btn-ghost" onClick={props.onSettings} title={`Settings (${MOD},)`}>
        Settings
      </button>
      <button className="btn btn-ghost btn-icon" onClick={props.onTheme} title="Switch theme" aria-label={`Switch to ${props.theme === "dark" ? "light" : "dark"} theme`}>
        <span className="theme-icon" />
      </button>

      {menu && <div className="popover-layer" onMouseDown={close} />}
      {menu === "pages" && (
        <div className="popover menu pages-pop" role="menu" aria-label="Pages">
          <div className="menu-label">Pages in this design</div>
          {props.pages.map((p) => (
            <button
              key={p}
              role="menuitemradio"
              aria-checked={p === props.page}
              className="menu-item mono"
              onClick={() => {
                props.onPage(p);
                close();
              }}
            >
              {p}
              {p === props.page && <span className="meta">✓</span>}
            </button>
          ))}
        </div>
      )}
      {menu === "providers" && (
        <div className="popover menu provider-pop" role="dialog" aria-label="Provider status">
          <div className="menu-label">Model per task</div>
          {tasks.map((t) => (
            <div key={t.task} className="provider-row">
              <div className="provider-row-head">
                <span className="provider-task">{TASKS.find((x) => x.id === t.task)?.label}</span>
                <span className="provider-model truncate">{t.model}</span>
                <span className="status">
                  <span className={`dot ${TONE_DOT[t.tone]}`} />
                  {t.label}
                </span>
              </div>
              <div className="provider-via">
                {t.provider}
                {t.via && ` · ${t.via}`}
              </div>
            </div>
          ))}
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => {
              close();
              props.onSettings();
            }}
          >
            Models and providers…<span className="meta">{MOD},</span>
          </button>
        </div>
      )}
    </header>
  );
}
