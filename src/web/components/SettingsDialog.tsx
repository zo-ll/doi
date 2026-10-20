import { useEffect, useRef, useState } from "react";
import { getJSON, sendJSON, type AppConfig, type Load, type ProviderStatus } from "../api.ts";
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

/** The same provider and model for every task. */
function sameForAll(ref: { provider: string; model: string }): AppConfig["models"] {
  return Object.fromEntries(TASKS.map((t) => [t.id, { ...ref }])) as AppConfig["models"];
}

/** The last entry of a model list: the user types the id. */
const TYPE_ID = " type"; // a model id has no space

function allSame(models: AppConfig["models"]): boolean {
  return TASKS.every((t) => models[t.id].provider === models.generate.provider && models[t.id].model === models.generate.model);
}

type ModelList = { state: "loading" } | { state: "ready"; models: string[] } | { state: "error"; message: string };

/**
 * The model ids of each provider that a task uses, from GET /api/providers/:id/models. A list
 * loads again when its provider becomes ready (for example after a key was added).
 */
function useModelLists(ids: string[], providers: ProviderStatus[]): Record<string, ModelList> {
  const [lists, setLists] = useState<Record<string, ModelList>>({});
  const wanted = [...new Set(ids)].map((id) => `${id}:${providers.find((p) => p.id === id)?.ready ? 1 : 0}`).sort().join(",");
  const loaded = useRef(new Set<string>());
  useEffect(() => {
    for (const entry of wanted.split(",").filter(Boolean)) {
      if (loaded.current.has(entry)) continue;
      loaded.current.add(entry);
      const id = entry.slice(0, entry.lastIndexOf(":"));
      setLists((l) => ({ ...l, [id]: l[id]?.state === "ready" ? l[id] : { state: "loading" } }));
      getJSON<{ models: string[] }>(`/api/providers/${id}/models`)
        .then(({ models }) => setLists((l) => ({ ...l, [id]: { state: "ready", models } })))
        .catch((e: unknown) => setLists((l) => ({ ...l, [id]: { state: "error", message: e instanceof Error ? e.message : String(e) } })));
    }
  }, [wanted]);
  return lists;
}

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
  const lists = useModelLists(TASKS.map((t) => draft[t.id].provider), list);
  // The provider's models first, then names the user has used with that provider.
  const suggestions = (provider: string) => {
    const l = lists[provider];
    const used = TASKS.flatMap((t) => (config.models[t.id].provider === provider ? [config.models[t.id].model] : []))
      .concat(Object.keys(config.prices).flatMap((r) => (r.startsWith(`${provider}:`) ? [r.slice(provider.length + 1)] : [])));
    return [...new Set([...(l?.state === "ready" ? l.models : []), ...used])];
  };

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
  const setTask = (task: Task | "all", patch: Partial<{ provider: string; model: string }>) => {
    setDraft((d) => (task === "all" ? sameForAll({ ...d.generate, ...patch }) : { ...d, [task]: { ...d[task], ...patch } }));
    setSaved(false);
  };
  // Rows where the user types a model id instead of a pick from the list.
  const [typed, setTyped] = useState<Set<string>>(() => new Set());
  // The row whose new control takes the focus when it mounts, after a switch between list and text.
  const focusRow = useRef<string | null>(null);
  const focusOnMount = (row: string) => (el: HTMLElement | null) => {
    if (el && focusRow.current === row) {
      focusRow.current = null;
      el.focus();
    }
  };
  const typeId = (row: string, on: boolean, focus = true) => {
    if (focus) focusRow.current = row;
    setTyped((s) => {
      const next = new Set(s);
      if (on) next.add(row);
      else next.delete(row);
      return next;
    });
  };
  // One model for all tasks, unless the config already uses different ones.
  const [perTask, setPerTask] = useState(() => !allSame(config.models));
  const rows: { id: Task | "all"; label: string; hint: string }[] = perTask ? TASKS : [{ id: "all", label: "All tasks", hint: "Generate, edit, extract" }];
  const togglePerTask = () => {
    if (perTask) setTask("all", {});
    setPerTask((p) => !p);
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

                <h4>Model</h4>
                <div className="task-list">
                  {rows.map((t) => {
                    const d = t.id === "all" ? draft.generate : draft[t.id];
                    const s = status(d.provider);
                    const models = suggestions(d.provider);
                    // A list shows every model; a datalist hides the ones that do not match the field.
                    const pick = models.length > 0 && !typed.has(t.id);
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
                          // A model id of one provider means nothing to another: the field starts empty and lists the models.
                          onChange={(e) => {
                            setTask(t.id, { provider: e.target.value, model: "" });
                            typeId(t.id, false, false);
                          }}
                        >
                          {options.map((p) => (
                            <option key={p.id} value={p.id}>
                              {providerName(p.id)}
                            </option>
                          ))}
                        </select>
                        {pick ? (
                          <select
                            ref={focusOnMount(t.id)}
                            className="select mono task-model"
                            value={models.includes(d.model) ? d.model : ""}
                            aria-label={`${t.label} model`}
                            aria-invalid={!MODEL.test(d.model.trim())}
                            onChange={(e) => (e.target.value === TYPE_ID ? typeId(t.id, true) : setTask(t.id, { model: e.target.value }))}
                          >
                            {!models.includes(d.model) && (
                              <option value="" disabled>
                                {d.model || "Select a model"}
                              </option>
                            )}
                            {models.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                            <option value={TYPE_ID}>Type a model id…</option>
                          </select>
                        ) : (
                          <span className="task-model-typed">
                            <input
                              ref={focusOnMount(t.id)}
                              className="input mono task-model"
                              placeholder={lists[d.provider]?.state === "loading" ? "Loading the models…" : "Type a model id"}
                              title={lists[d.provider]?.state === "error" ? `The models cannot load: ${(lists[d.provider] as { message: string }).message}` : undefined}
                              value={d.model}
                              aria-label={`${t.label} model`}
                              aria-invalid={!MODEL.test(d.model.trim())}
                              spellCheck={false}
                              onChange={(e) => setTask(t.id, { model: e.target.value })}
                            />
                            {models.length > 0 && (
                              <button className="btn btn-ghost btn-md" onClick={() => typeId(t.id, false)} title="Select from the models of the provider">
                                List
                              </button>
                            )}
                          </span>
                        )}
                        <span className="status task-status">
                          <span className={`dot ${TONE_DOT[s.tone]}`} />
                          {s.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <button className="btn btn-ghost btn-md per-task-toggle" onClick={togglePerTask}>
                  {perTask ? "Use one model for all tasks" : "Use a different model per task"}
                </button>
                {[...new Set(TASKS.map((t) => draft[t.id].provider))].map((id) => {
                  const l = lists[id];
                  return l?.state === "error" ? (
                    <p key={id} className="settings-note" role="status">
                      <span className="dot dot-warn" /> {providerName(id)}: the models cannot load. {l.message} Type a model id.
                    </p>
                  ) : null;
                })}
                <p className="settings-note">
                  Menus list only providers that are ready. The model list shows the models of the provider; you can also type an id. {config.configPath ? <>doi writes the choice to <span className="mono">{config.configPath}</span>, only its [models] lines.</> : "doi runs without a config file, so the choice lasts until it stops."}
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
                  <button className="btn btn-ghost" disabled={!changed || busy} onClick={() => {
                      setDraft(config.models);
                      setPerTask(!allSame(config.models));
                    }}>
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
