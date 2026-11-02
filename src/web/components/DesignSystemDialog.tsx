import { useEffect, useRef, useState } from "react";
import { getJSON, sendJSON, type DesignSystemView, type ImportStreamEvent, type ProjectSummary } from "../api.ts";
import { readEvents } from "../chat.ts";
import { prepareImage, type PreparedImage } from "../images.ts";
import { shortModel, type TaskStatus } from "../providers.ts";
import { IMAGE_LIMITS } from "../../workspace/image-limits.ts";
import type { Token } from "../../workspace/design-systems.ts";

type Mode = { kind: "view"; name: string | null } | { kind: "repo" } | { kind: "screenshots" };
type Tab = "tokens" | "components" | "rules" | "files";

const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const TONE_DOT = { ok: "dot-ok", warn: "dot-warn", err: "dot-err", unknown: "" } as const;

/** The editor link for a file: config.toml `editor_url`, with {path} replaced. */
export function editorLink(template: string, dir: string, file: string): string {
  const path = `${dir.replace(/\/$/, "")}/${file}`;
  return template.replace("{path}", path.split("/").map(encodeURIComponent).join("/"));
}

/**
 * A type token on the sample text. The name says weight, line height or letter spacing; else
 * a length is a font size and anything other is a font stack.
 */
export function typeStyle(t: Pick<Token, "name" | "resolved">): React.CSSProperties {
  const n = t.name.toLowerCase();
  const v = t.resolved.trim();
  if (/weight/.test(n)) return { fontWeight: v as React.CSSProperties["fontWeight"] };
  if (/leading|line-height/.test(n)) return { lineHeight: v };
  if (/tracking|letter/.test(n)) return { letterSpacing: v };
  if (/^-?[\d.]+(px|rem|em|%|pt)?$|^(clamp|calc|min|max)\(/i.test(v)) return { fontSize: v };
  return { fontFamily: v };
}

/** The design systems dialog (⌘D): one system per project, or none. */
export function DesignSystemDialog({ project, projects, editorUrl, extract, onClose, onChanged }: {
  project: ProjectSummary;
  /** All projects, to say which ones use each system. */
  projects: ProjectSummary[];
  editorUrl: string;
  /** The extract model and its status, for the import forms. */
  extract: TaskStatus | null;
  onClose: () => void;
  /** The project's design system changed, or a new one was imported. */
  onChanged: () => void;
}) {
  const [list, setList] = useState<string[] | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "view", name: project.designSystem });
  const [reloads, setReloads] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getJSON<string[]>("/api/design-systems")
      .then((names) => {
        setList(names);
        // Show the project's design system, or else the first one.
        setMode((m) => (m.kind === "view" && m.name === null && names.length ? { kind: "view", name: names[0]! } : m));
      })
      .catch((e) => setError(`The design systems cannot load: ${(e as Error).message}`));
  }, [reloads]);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const use = async (name: string | null) => {
    setError(null);
    try {
      await sendJSON("PUT", `/api/projects/${project.id}/design-system`, { name });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const imported = (name: string) => {
    setReloads((n) => n + 1);
    setMode({ kind: "view", name });
    onChanged();
  };

  const usedBy = (name: string) => {
    if (project.designSystem === name) return { text: "Used by this project", on: true };
    const others = projects.filter((p) => p.designSystem === name).map((p) => p.name);
    return { text: others.length ? `Used by ${others.join(", ")}` : "Not used", on: false };
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog ds-dialog" role="dialog" aria-modal="true" aria-label="Design systems" tabIndex={-1} ref={ref}>
        <nav className="ds-side" aria-label="Design system list">
          <div className="dialog-head">
            <h2>Design systems</h2>
          </div>
          <div className="ds-list">
            {list === null && !error && <div className="skeleton comment-skeleton" aria-label="Loading" />}
            {list?.map((name) => {
              const u = usedBy(name);
              const current = mode.kind === "view" && mode.name === name;
              return (
                <button key={name} className="ds-item" aria-current={current} onClick={() => setMode({ kind: "view", name })}>
                  <span className="ds-item-name truncate">{name}</span>
                  <span className={`ds-item-meta${u.on ? " is-on" : ""}`}>{u.text}</span>
                </button>
              );
            })}
          </div>
          <div className="ds-side-actions">
            <button className="btn btn-secondary" aria-pressed={mode.kind === "repo"} onClick={() => setMode({ kind: "repo" })}>
              Import from a repo…
            </button>
            <button className="btn btn-secondary" aria-pressed={mode.kind === "screenshots"} onClick={() => setMode({ kind: "screenshots" })}>
              Import from screenshots…
            </button>
          </div>
        </nav>

        <section className="ds-main">
          {error && (
            <div className="banner banner-err ds-error" role="alert">
              <span className="dot dot-err" />
              {error}
            </div>
          )}
          {mode.kind === "view" && mode.name && (
            <DesignSystemDetails
              key={`${mode.name}-${reloads}`}
              name={mode.name}
              inUse={project.designSystem === mode.name}
              projectName={project.name}
              editorUrl={editorUrl}
              onUse={() => void use(mode.name)}
              onStop={() => void use(null)}
              onClose={onClose}
            />
          )}
          {mode.kind === "view" && !mode.name && list?.length === 0 && (
            <div className="ds-empty">
              <button className="icon-btn ds-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
                ×
              </button>
              <h3>No design systems yet</h3>
              <p>A design system gives the model your colors, type, spacing, components and rules. Read one from a repo, or from screenshots of a product.</p>
              <div className="ds-empty-actions">
                <button className="btn btn-primary" onClick={() => setMode({ kind: "repo" })}>
                  From a repo
                </button>
                <button className="btn btn-secondary" onClick={() => setMode({ kind: "screenshots" })}>
                  From screenshots
                </button>
              </div>
            </div>
          )}
          {mode.kind === "repo" && <RepoImport extract={extract} onImported={imported} onCancel={() => setMode({ kind: "view", name: project.designSystem ?? list?.[0] ?? null })} />}
          {mode.kind === "screenshots" && (
            <ScreenshotImport extract={extract} onImported={imported} onCancel={() => setMode({ kind: "view", name: project.designSystem ?? list?.[0] ?? null })} />
          )}
        </section>
      </div>
    </div>
  );
}

function DesignSystemDetails({ name, inUse, projectName, editorUrl, onUse, onStop, onClose }: {
  name: string;
  inUse: boolean;
  projectName: string;
  editorUrl: string;
  onUse: () => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<DesignSystemView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tokens");
  const [preview, setPreview] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    getJSON<DesignSystemView>(`/api/design-systems/${name}`)
      .then(setView)
      .catch((e) => setError((e as Error).message));
  }, [name]);

  const head = (
    <div className="dialog-head">
      <h2>{name}</h2>
      {view && <span className="ds-dir truncate" title={view.dir}>{view.dir}</span>}
      <span className="spacer" />
      {inUse ? (
        <button className="btn btn-secondary" onClick={onStop}>
          Stop using in {projectName}
        </button>
      ) : (
        <button className="btn btn-primary" onClick={onUse}>
          Use in {projectName}
        </button>
      )}
      <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
        ×
      </button>
    </div>
  );

  if (error) {
    return (
      <>
        {head}
        <div className="banner banner-err ds-error" role="alert">
          <span className="dot dot-err" />
          {error}
        </div>
      </>
    );
  }
  if (!view) {
    return (
      <>
        {head}
        <div className="ds-body" aria-busy="true" aria-label="Loading the design system">
          <div className="skeleton comment-skeleton" />
        </div>
      </>
    );
  }
  const group = (g: Token["group"]) => view.tokens.filter((t) => t.group === g);
  const copy = (f: string) => {
    void navigator.clipboard?.writeText(`${view.dir}/${f}`);
    setCopied(f);
  };

  return (
    <>
      {head}
      <div className="tabs ds-tabs" role="tablist">
        {(["tokens", "components", "rules", "files"] as const).map((t) => (
          <button key={t} className="tab" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === "files" ? `Files · ${view.files.length}` : t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="ds-body">
        {tab === "tokens" &&
          (view.tokens.length === 0 ? (
            <p className="ds-none">This design system has no tokens.css.</p>
          ) : (
            <div className="ds-tokens">
              <div className="ds-col">
                {group("color").length > 0 && (
                  <section>
                    <h4>Colors · {group("color").length}</h4>
                    <div className="swatches">
                      {group("color").map((t) => (
                        <div key={t.name} className="swatch">
                          <span className="swatch-chip" style={{ background: t.resolved }} />
                          <span className="swatch-name">{t.name.replace(/^--/, "")}</span>
                          <span className="swatch-value">{t.value}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                {group("type").length > 0 && (
                  <section>
                    <h4>Type</h4>
                    <div className="type-card">
                      {group("type").map((t) => (
                        <div key={t.name} className="type-row">
                          <span className="type-name">{t.name.replace(/^--/, "")}</span>
                          <span className="type-sample" style={typeStyle(t)}>
                            The quick brown fox
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>
              <div className="ds-col">
                {group("space").length > 0 && (
                  <section>
                    <h4>Spacing</h4>
                    {group("space").map((t) => (
                      <div key={t.name} className="space-row">
                        <span className="space-name">{t.name.replace(/^--/, "")}</span>
                        <span className="space-bar" style={{ width: t.resolved }} />
                        <span className="space-value">{t.value}</span>
                      </div>
                    ))}
                  </section>
                )}
                {group("radius").length > 0 && (
                  <section>
                    <h4>Radius</h4>
                    <div className="shape-samples">
                      {group("radius").map((t) => (
                        <div key={t.name} className="shape-sample">
                          <span className="shape-box" style={{ borderRadius: t.resolved }} />
                          <span className="space-value">{t.name.replace(/^--/, "")}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                {group("shadow").length > 0 && (
                  <section>
                    <h4>Shadows</h4>
                    <div className="shadow-card">
                      {group("shadow").map((t) => (
                        <span key={t.name} className="shadow-box" style={{ boxShadow: t.resolved }}>
                          {t.name.replace(/^--/, "")}
                        </span>
                      ))}
                    </div>
                  </section>
                )}
                {group("other").length > 0 && (
                  <section>
                    <h4>Other tokens</h4>
                    {group("other").map((t) => (
                      <div key={t.name} className="other-row">
                        <span className="mono">{t.name}</span>
                        <span className="space-value truncate">{t.value}</span>
                      </div>
                    ))}
                  </section>
                )}
              </div>
            </div>
          ))}

        {tab === "components" &&
          (view.hasComponents ? (
            <section className="ds-components">
              <div className="ds-components-head">
                <h4>Live preview · components.html</h4>
                <span className="spacer" />
                <span className="muted">Rendered with the system's own CSS</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setPreview((n) => n + 1)} title="Load again after an edit">
                  Reload
                </button>
              </div>
              <iframe className="ds-preview" src={`/ds/${view.name}/preview.html?v=${preview}`} title={`${view.name} components`} sandbox="allow-scripts" />
            </section>
          ) : (
            <p className="ds-none">This design system has no components.html.</p>
          ))}

        {tab === "rules" &&
          (view.rules ? (
            <section className="ds-rules">
              <h4>Rules · rules.md</h4>
              <div className="ds-rules-text">{view.rules}</div>
            </section>
          ) : (
            <p className="ds-none">This design system has no rules.md.</p>
          ))}

        {tab === "files" && (
          <section className="ds-files">
            <h4 className="truncate">Files · {view.dir}</h4>
            <div className="ds-file-list">
              {view.files.map((f) => (
                <div key={f} className="ds-file">
                  <span className="mono truncate spacer">{f}</span>
                  <a className="btn btn-ghost btn-sm" href={editorLink(editorUrl, view.dir, f)}>
                    Open in editor
                  </a>
                  <button className="btn btn-ghost btn-sm" onClick={() => copy(f)}>
                    {copied === f ? "Copied" : "Copy path"}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

type ImportStatus = {
  running: boolean;
  text: string;
  sources: string[];
  seen: number;
  error: string | null;
  started: number;
};

/** Streams an import and reports its progress. Stop aborts it. */
function useImport(onImported: (name: string) => void) {
  const [status, setStatus] = useState<ImportStatus>({ running: false, text: "", sources: [], seen: 0, error: null, started: 0 });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const run = async (url: string, body: unknown) => {
    const controller = new AbortController();
    abort.current = controller;
    setStatus({ running: true, text: "", sources: [], seen: 0, error: null, started: Date.now() });
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      if (!res.ok || !res.body) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        setStatus((s) => ({ ...s, running: false, error: b?.error ?? `The import failed: ${res.status}` }));
        return;
      }
      let done = false;
      for await (const e of readEvents<ImportStreamEvent>(res.body)) {
        if (e.type === "sources") setStatus((s) => ({ ...s, sources: e.files, seen: e.seen }));
        if (e.type === "text") setStatus((s) => ({ ...s, text: s.text + e.delta }));
        if (e.type === "error") {
          done = true;
          setStatus((s) => ({ ...s, running: false, error: e.message }));
        }
        if (e.type === "imported") {
          done = true;
          setStatus((s) => ({ ...s, running: false }));
          onImported(e.name);
        }
      }
      if (!done) setStatus((s) => ({ ...s, running: false, error: "The connection closed before the import ended." }));
    } catch (e) {
      setStatus((s) => ({ ...s, running: false, error: controller.signal.aborted ? "Stopped. No design system was made." : `The import failed: ${(e as Error).message}` }));
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  };
  return { status, run, stop: () => abort.current?.abort() };
}

/** Seconds since the start, as m:ss, while the import runs. */
function useElapsed(started: number, running: boolean): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const s = Math.max(0, Math.round((now - started) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function ImportProgress({ status, extract, label }: { status: ImportStatus; extract: TaskStatus | null; label: string }) {
  const elapsed = useElapsed(status.started, status.running);
  if (!status.running && !status.error && !status.text) return null;
  return (
    <div className="import-progress" role="status">
      <div className="import-progress-head">
        {status.running ? <span className="spinner" /> : status.error ? <span className="dot dot-err" /> : <span className="dot dot-ok" />}
        <strong>{status.running ? label : status.error ? "The import failed" : "Imported"}</strong>
        {extract && (
          <span className="mono muted">
            {shortModel(extract.model)} · extract{status.running ? ` · ${elapsed}` : ""}
          </span>
        )}
        <span className="spacer" />
        {status.sources.length > 0 && <span className="mono muted">{status.sources.length} files read</span>}
      </div>
      {status.error && <p className="import-error">{status.error}</p>}
      <div className="import-panes">
        {status.sources.length > 0 && (
          <div className="import-files">
            <h4>Files read</h4>
            {status.sources.map((f) => (
              <div key={f} className="import-file">
                <span className="import-check">✓</span>
                <span className="truncate">{f}</span>
              </div>
            ))}
          </div>
        )}
        {status.text && (
          <div className="import-model">
            <h4>Model</h4>
            <p>{status.text}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ImportFooter({ extract, running, canStart, start, onStop, onCancel, note }: {
  extract: TaskStatus | null;
  running: boolean;
  canStart: boolean;
  start: string;
  onStop: () => void;
  onCancel: () => void;
  note?: string;
}) {
  return (
    <div className="dialog-foot">
      {note ? (
        <span className="muted">{note}</span>
      ) : (
        extract && (
          <span className="status mono">
            <span className={`dot ${TONE_DOT[extract.tone]}`} />
            {shortModel(extract.model)} · extract
          </span>
        )
      )}
      <span className="spacer" />
      {running ? (
        <button type="button" className="btn btn-secondary" onClick={onStop}>
          <span className="stop-square" />
          Stop
        </button>
      ) : (
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!canStart}>
            {start}
          </button>
        </>
      )}
    </div>
  );
}

function RepoImport({ extract, onImported, onCancel }: { extract: TaskStatus | null; onImported: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const { status, run, stop } = useImport(onImported);
  const valid = NAME.test(name) && repo.startsWith("/");
  return (
    <form
      className="import-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !status.running) void run("/api/design-systems/import", { name, repo });
      }}
    >
      <div className="dialog-head">
        <h2>Import from a local repo</h2>
      </div>
      <div className="import-body">
        <div className="import-fields">
          <label className="field">
            Name
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-product" spellCheck={false} aria-invalid={!!name && !NAME.test(name)} disabled={status.running} />
            {name && !NAME.test(name) && <span className="field-error">Use a-z, 0-9 and "-".</span>}
          </label>
          <label className="field">
            Folder (absolute path)
            <input className="input mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="/home/me/code/my-product" spellCheck={false} disabled={status.running} />
          </label>
        </div>
        <p className="muted import-help">doi reads the theme files, the stylesheets with tokens and the main components. The extract model writes a design system from them.</p>
        <ImportProgress status={status} extract={extract} label="Reading source files" />
      </div>
      <ImportFooter
        extract={extract}
        running={status.running}
        canStart={valid}
        start={status.error ? "Retry import" : "Import"}
        onStop={stop}
        onCancel={onCancel}
        note="doi reads files only. Nothing in the repo changes."
      />
    </form>
  );
}

function ScreenshotImport({ extract, onImported, onCancel }: { extract: TaskStatus | null; onImported: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const { status, run, stop } = useImport(onImported);
  const valid = NAME.test(name) && images.length > 0;
  // The server refuses screenshots for an extract model without vision; say so before the upload.
  const noVision = extract?.vision === false;

  const add = async (files: File[]) => {
    setImageError(null);
    const out: PreparedImage[] = [];
    for (const f of files.filter((x) => x.type.startsWith("image/")).slice(0, IMAGE_LIMITS.count - images.length)) {
      try {
        out.push(await prepareImage(f));
      } catch (e) {
        setImageError((e as Error).message);
      }
    }
    setImages((list) => [...list, ...out].slice(0, IMAGE_LIMITS.count));
  };

  return (
    <form
      className="import-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !status.running) {
          void run("/api/design-systems/import-screenshots", { name, notes, images: images.map(({ mediaType, data }) => ({ mediaType, data })) });
        }
      }}
      onPaste={(e) => {
        const files = [...e.clipboardData.files];
        if (files.some((f) => f.type.startsWith("image/"))) {
          e.preventDefault();
          void add(files);
        }
      }}
    >
      <div className="dialog-head">
        <h2>Import from screenshots</h2>
      </div>
      <div className="import-body">
        {noVision && extract && (
          <p className="field-error" role="alert">
            The extract model {shortModel(extract.model)} cannot read images. Choose an extract model with vision in Settings, Models and providers.
          </p>
        )}
        <label className="field">
          Name
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-product" spellCheck={false} aria-invalid={!!name && !NAME.test(name)} disabled={status.running} />
          {name && !NAME.test(name) && <span className="field-error">Use a-z, 0-9 and "-".</span>}
        </label>
        <label
          className={`dropzone${over ? " is-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void add([...e.dataTransfer.files]);
          }}
        >
          <strong>Drop 1–{IMAGE_LIMITS.count} screenshots</strong>
          <span className="muted">
            PNG or JPG · or <span className="link-text">choose files</span> · paste works too
          </span>
          <input
            type="file"
            className="visually-hidden"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            disabled={status.running || images.length >= IMAGE_LIMITS.count}
            onChange={(e) => {
              void add([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
        </label>
        {images.length > 0 && (
          <div className="shot-list">
            {images.map((img, i) => (
              <span key={i} className="shot">
                <img src={img.url} alt={`Screenshot ${i + 1}`} />
                <button type="button" aria-label={`Remove screenshot ${i + 1}`} onClick={() => setImages((l) => l.filter((_, j) => j !== i))}>
                  ×
                </button>
              </span>
            ))}
            <span className="muted shot-count">
              {images.length} of {IMAGE_LIMITS.count}
            </span>
          </div>
        )}
        {imageError && <p className="field-error">{imageError}</p>}
        <label className="field">
          Notes for the model (optional)
          <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="For example: headings are GT Sectra; ignore the cookie banner." disabled={status.running} />
        </label>
        <ImportProgress status={status} extract={extract} label="Reading the screenshots" />
      </div>
      <ImportFooter extract={extract} running={status.running} canStart={valid && !noVision} start={status.error ? "Retry import" : "Extract design system"} onStop={stop} onCancel={onCancel} />
    </form>
  );
}
