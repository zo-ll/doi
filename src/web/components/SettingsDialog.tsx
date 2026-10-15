import { useEffect, useRef, useState } from "react";
import { sendJSON, type AppConfig, type Load, type ProviderStatus } from "../api.ts";
import { providerName, statusOf, TASKS, type Task } from "../providers.ts";
import type { ThemeChoice } from "../theme.ts";
import type { WorkspaceState } from "./ProjectsNav.tsx";
import { ProviderAuth } from "./ProviderAuth.tsx";
import { MOD } from "./TopBar.tsx";

type Section = "models" | "appearance" | "workspace" | "shortcuts";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "models", label: "Models and providers" },
  { id: "appearance", label: "Appearance" },
  { id: "workspace", label: "Workspace" },
  { id: "shortcuts", label: "Shortcuts" },
];
const TONE_DOT = { ok: "dot-ok", warn: "dot-warn", err: "dot-err", unknown: "" } as const;
/** A model name that goes to a CLI as an argument must not look like a flag. */
const MODEL = /^[A-Za-z0-9._@/][A-Za-z0-9._:@/-]{0,99}$/;

const SHORTCUTS: [string, string][] = [
  ["Projects", `${MOD}P`],
  ["Collapse chat / side panel", `${MOD}[  ${MOD}]`],
  ["Design system", `${MOD}D`],
  ["Export / Hand off", `${MOD}E  ${MOD}⇧H`],
  ["Settings", `${MOD},`],
  ["Select / Comment / Hand tool", "V  C  H"],
  ["New comment on the selection", "N"],
  ["Add frame", "F"],
  ["Tweaks", "T"],
  ["Zoom in / out / 100% / fit", "+  −  0  ⇧1"],
  ["Send / stop", `${MOD}↵  Esc`],
  ["Select the parent element", "⇧-click"],
];

/** Settings (⌘,): the model per task (#61), the theme, the workspace and the shortcuts. */
export function SettingsDialog({ config, providers, workspace, themeChoice, onTheme, onRecheck, onSaved, onClose, onExportWorkspace, onImport }: {
  config: AppConfig;
  providers: Load<ProviderStatus[]>;
  workspace: Load<WorkspaceState>;
  themeChoice: ThemeChoice;
  onTheme: (c: ThemeChoice) => void;
  /** Asks the providers for their status again. */
  onRecheck: () => void;
  /** The model choice was saved; the app loads the config again. */
  onSaved: () => void;
  onClose: () => void;
  onExportWorkspace: () => void;
  onImport: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<Section>("models");
  const [draft, setDraft] = useState(() => Object.fromEntries(TASKS.map((t) => [t.id, { ...config.models[t.id] }])) as AppConfig["models"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const list = providers.state === "ready" ? providers.data : [];
  const ready = list.filter((p) => p.ready && p.implemented);
  const status = (id: string) => statusOf(list.find((p) => p.id === id));
  const changed = TASKS.some((t) => draft[t.id].provider !== config.models[t.id].provider || draft[t.id].model !== config.models[t.id].model);
  const valid = TASKS.every((t) => MODEL.test(draft[t.id].model.trim()));
  // Model names the user has used, offered in each field.
  const known = [...new Set(TASKS.flatMap((t) => [config.models[t.id].model, draft[t.id].model]).concat(Object.keys(config.prices).map((r) => r.split(":").slice(1).join(":"))))];

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendJSON(
        "PUT",
        "/api/config/models",
        Object.fromEntries(TASKS.map((t) => [t.id, `${draft[t.id].provider}:${draft[t.id].model.trim()}`])),
      );
      setSaved(true);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const setTask = (task: Task, patch: Partial<{ provider: string; model: string }>) => {
    setDraft((d) => ({ ...d, [task]: { ...d[task], ...patch } }));
    setSaved(false);
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog settings-dialog" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1} ref={ref}>
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="dialog-head">
            <h2>Settings</h2>
          </div>
          <div className="settings-sections">
            {SECTIONS.map((s) => (
              <button key={s.id} className="settings-section" aria-current={section === s.id} onClick={() => setSection(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        </nav>
        <section className="settings-main">
          <div className="dialog-head">
            <h2>{SECTIONS.find((s) => s.id === section)?.label}</h2>
            <span className="spacer" />
            <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
              ×
            </button>
          </div>
          <div className="settings-body">
            {section === "models" && (
              <>
                <h4>Providers</h4>
                {providers.state === "error" && (
                  <div className="banner banner-err" role="alert">
                    <span className="dot dot-err" />
                    The providers cannot load: {providers.message}
                  </div>
                )}
                {providers.state === "loading" ? (
                  <div className="skeleton comment-skeleton" aria-label="Checking the providers" />
                ) : (
                  <ProviderAuth providers={list} initial={config.models.generate.provider} onRecheck={onRecheck} />
                )}
                <p className="settings-note">
                  doi never shows a key or an account detail. A key that you add goes to the system keychain, or to a file that only you can read when there is no keychain. An OAuth login goes through the official CLI, which keeps the token.
                </p>

                <h4>Model per task</h4>
                <div className="task-list">
                  {TASKS.map((t) => {
                    const d = draft[t.id];
                    const s = status(d.provider);
                    const options = ready.some((p) => p.id === d.provider) ? ready : [...ready, ...list.filter((p) => p.id === d.provider)];
                    return (
                      <div key={t.id} className="task-row">
                        <div className="task-name">
                          <span>{t.label}</span>
                          <span className="muted">{t.hint}</span>
                        </div>
                        <select
                          className="select task-provider"
                          value={d.provider}
                          aria-label={`${t.label} provider`}
                          onChange={(e) => setTask(t.id, { provider: e.target.value })}
                        >
                          {options.map((p) => (
                            <option key={p.id} value={p.id}>
                              {providerName(p.id)}
                            </option>
                          ))}
                        </select>
                        <input
                          className="input mono task-model"
                          list="doi-known-models"
                          value={d.model}
                          aria-label={`${t.label} model`}
                          aria-invalid={!MODEL.test(d.model.trim())}
                          spellCheck={false}
                          onChange={(e) => setTask(t.id, { model: e.target.value })}
                        />
                        <span className="status task-status">
                          <span className={`dot ${TONE_DOT[s.tone]}`} />
                          {s.label}
                        </span>
                      </div>
                    );
                  })}
                  <datalist id="doi-known-models">
                    {known.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </div>
                <p className="settings-note">
                  Menus list only providers that are ready. {config.configPath ? <>doi writes the choice to <span className="mono">{config.configPath}</span>, only its [models] lines.</> : "doi runs without a config file, so the choice lasts until it stops."}
                </p>
                {error && (
                  <div className="banner banner-err" role="alert">
                    <span className="dot dot-err" />
                    {error}
                  </div>
                )}
                <div className="settings-actions">
                  {saved && !changed && <span className="status">Saved. The next turn uses these models.</span>}
                  <span className="spacer" />
                  <button className="btn btn-ghost" disabled={!changed || busy} onClick={() => setDraft(config.models)}>
                    Reset
                  </button>
                  <button className="btn btn-primary" disabled={!changed || !valid || busy} onClick={() => void save()}>
                    Save
                  </button>
                </div>

              </>
            )}

            {section === "appearance" && (
              <>
                <h4>Theme</h4>
                <div className="seg" role="radiogroup" aria-label="Theme">
                  {([null, "light", "dark"] as const).map((c) => (
                    <button key={String(c)} className="seg-item" role="radio" aria-checked={themeChoice === c} onClick={() => onTheme(c)}>
                      {c === null ? "System" : c === "light" ? "Light" : "Dark"}
                    </button>
                  ))}
                </div>
                <p className="settings-note">Design pages stay white paper in both themes. The choice is stored in this browser.</p>
              </>
            )}

            {section === "workspace" && (
              <>
              <div className="settings-actions">
                <span className="settings-note spacer">
                  doi keeps your work in the workspace folder. Export a file to move it to another computer, keep a backup, or share it.
                </span>
                <button className="btn btn-secondary" onClick={onImport}>
                  Import…
                </button>
                <button className="btn btn-primary" onClick={onExportWorkspace}>
                  Export the workspace…
                </button>
              </div>
              <dl className="settings-facts">
                <dt>Workspace</dt>
                <dd className="mono">{workspace.state === "ready" ? workspace.data.path : config.workspace}</dd>
                <dt>Git</dt>
                <dd>
                  {workspace.state !== "ready"
                    ? "…"
                    : workspace.data.changes === null
                      ? "Off: doi keeps working, but without version history."
                      : workspace.data.changes === 0
                        ? "Clean"
                        : `${workspace.data.changes} uncommitted files`}
                </dd>
                <dt>Config file</dt>
                <dd className="mono">{config.configPath ?? "none"}</dd>
                <dt>Editor links</dt>
                <dd className="mono">{config.editorUrl}</dd>
                <dt>Prices</dt>
                <dd>{Object.keys(config.prices).length ? `${Object.keys(config.prices).length} models in [prices]` : "None. Add a [prices] table to config.toml for cost estimates."}</dd>
              </dl>
              </>
            )}

            {section === "shortcuts" && (
              <div className="shortcut-list">
                {SHORTCUTS.map(([what, keys]) => (
                  <div key={what} className="shortcut">
                    <span>{what}</span>
                    <span className="kbd kbd-box">{keys}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
