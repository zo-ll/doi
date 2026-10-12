import { useEffect, useRef, useState } from "react";
import { getJSON, sendJSON, type DesignSystemView, type ImportStreamEvent, type ProjectSummary } from "../api.ts";
import { readEvents } from "../chat.ts";
import { prepareImage, type PreparedImage } from "../images.ts";
import { IMAGE_LIMITS } from "../../workspace/image-limits.ts";
import type { Token } from "../../workspace/design-systems.ts";
import { Icon } from "./Icon.tsx";

type Mode = { kind: "view"; name: string | null } | { kind: "repo" } | { kind: "screenshots" };

const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** The editor link for a file: config.toml `editor_url`, with {path} replaced. */
export function editorLink(template: string, dir: string, file: string): string {
  const path = `${dir.replace(/\/$/, "")}/${file}`;
  return template.replace("{path}", path.split("/").map(encodeURIComponent).join("/"));
}

export function DesignSystemDialog({ project, editorUrl, onClose, onChanged }: {
  project: ProjectSummary;
  editorUrl: string;
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

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ds-dialog" role="dialog" aria-modal="true" aria-label="Design systems" tabIndex={-1} ref={ref}>
        <header className="ds-head">
          <h2>Design systems</h2>
          <span className="muted">
            {project.name}: {project.designSystem ?? "none"}
          </span>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <Icon name="close" />
          </button>
        </header>
        <div className="ds-body">
          <nav className="ds-list" aria-label="Design system list">
            {list === null && !error && <div className="skeleton comments-skeleton" aria-label="Loading" />}
            {list?.length === 0 && <p className="muted ds-empty">No design systems yet. Import one.</p>}
            {list?.map((name) => (
              <button
                key={name}
                className={`ds-list-item${mode.kind === "view" && mode.name === name ? " is-active" : ""}`}
                onClick={() => setMode({ kind: "view", name })}
                aria-current={mode.kind === "view" && mode.name === name}
              >
                <span className="truncate">{name}</span>
                {project.designSystem === name && <span className="badge-current">In use</span>}
              </button>
            ))}
            <div className="ds-list-actions">
              <button className={`btn btn-secondary${mode.kind === "repo" ? " is-active" : ""}`} onClick={() => setMode({ kind: "repo" })}>
                Import from a repo
              </button>
              <button className={`btn btn-secondary${mode.kind === "screenshots" ? " is-active" : ""}`} onClick={() => setMode({ kind: "screenshots" })}>
                Import from screenshots
              </button>
            </div>
          </nav>
          <section className="ds-main">
            {error && (
              <div className="notice notice-danger" role="alert">
                <Icon name="alert" />
                <span>{error}</span>
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
              />
            )}
            {mode.kind === "view" && !mode.name && list?.length === 0 && (
              <div className="chat-empty">
                <h2>No design system</h2>
                <p>A design system gives every design of a project the same colors, type, spacing and components. Import one from a repo or from screenshots of a product.</p>
              </div>
            )}
            {mode.kind === "repo" && <RepoImport onImported={imported} />}
            {mode.kind === "screenshots" && <ScreenshotImport onImported={imported} />}
          </section>
        </div>
      </div>
    </div>
  );
}

function DesignSystemDetails({ name, inUse, projectName, editorUrl, onUse, onStop }: {
  name: string;
  inUse: boolean;
  projectName: string;
  editorUrl: string;
  onUse: () => void;
  onStop: () => void;
}) {
  const [view, setView] = useState<DesignSystemView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(0);

  useEffect(() => {
    getJSON<DesignSystemView>(`/api/design-systems/${name}`)
      .then(setView)
      .catch((e) => setError((e as Error).message));
  }, [name]);

  if (error) return <p className="notice notice-danger" role="alert">{error}</p>;
  if (!view) return <div className="skeleton comments-skeleton" aria-label="Loading the design system" />;
  const group = (g: Token["group"]) => view.tokens.filter((t) => t.group === g);

  return (
    <div className="ds-details">
      <div className="ds-details-head">
        <h3>{view.name}</h3>
        {inUse ? (
          <>
            <span className="muted">Used by {projectName}</span>
            <button className="btn btn-secondary" onClick={onStop}>Stop using</button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={onUse}>Use for {projectName}</button>
        )}
      </div>

      {view.tokens.length === 0 && <p className="muted">This design system has no tokens.css.</p>}
      {group("color").length > 0 && (
        <TokenSection title="Colors">
          <div className="swatches">
            {group("color").map((t) => (
              <div key={t.name} className="swatch">
                <span className="swatch-chip" style={{ background: t.resolved }} />
                <code>{t.name}</code>
                <span className="muted">{t.value}</span>
              </div>
            ))}
          </div>
        </TokenSection>
      )}
      {group("type").length > 0 && (
        <TokenSection title="Type">
          {group("type").map((t) => (
            <div key={t.name} className="token-row">
              <code>{t.name}</code>
              <span className="type-sample" style={typeStyle(t)}>The quick brown fox</span>
              <span className="muted">{t.value}</span>
            </div>
          ))}
        </TokenSection>
      )}
      {group("space").length > 0 && (
        <TokenSection title="Spacing">
          {group("space").map((t) => (
            <div key={t.name} className="token-row">
              <code>{t.name}</code>
              <span className="space-bar" style={{ width: t.resolved }} />
              <span className="muted">{t.value}</span>
            </div>
          ))}
        </TokenSection>
      )}
      {(group("radius").length > 0 || group("shadow").length > 0) && (
        <TokenSection title="Radius and shadows">
          <div className="shape-samples">
            {group("radius").map((t) => (
              <div key={t.name} className="shape-sample">
                <span className="shape-box" style={{ borderRadius: t.resolved }} />
                <code>{t.name}</code>
                <span className="muted">{t.value}</span>
              </div>
            ))}
            {group("shadow").map((t) => (
              <div key={t.name} className="shape-sample">
                <span className="shape-box" style={{ boxShadow: t.resolved }} />
                <code>{t.name}</code>
              </div>
            ))}
          </div>
        </TokenSection>
      )}
      {group("other").length > 0 && (
        <TokenSection title="Other tokens">
          {group("other").map((t) => (
            <div key={t.name} className="token-row">
              <code>{t.name}</code>
              <span className="muted">{t.value}</span>
            </div>
          ))}
        </TokenSection>
      )}

      <TokenSection
        title="Components"
        action={
          <button className="icon-btn" onClick={() => setPreview((n) => n + 1)} aria-label="Load the components again" title="Load again after an edit">
            <Icon name="undo" />
          </button>
        }
      >
        {view.hasComponents ? (
          <iframe
            className="ds-preview"
            src={`/ds/${view.name}/preview.html?v=${preview}`}
            title={`${view.name} components`}
            sandbox="allow-scripts"
          />
        ) : (
          <p className="muted">This design system has no components.html.</p>
        )}
      </TokenSection>

      {view.rules && (
        <TokenSection title="Rules">
          <p className="ds-rules">{view.rules}</p>
        </TokenSection>
      )}

      <TokenSection title="Files">
        <p className="muted ds-dir">{view.dir}</p>
        {view.files.map((f) => (
          <div key={f} className="token-row">
            <code className="truncate">{f}</code>
            <a className="link-btn" href={editorLink(editorUrl, view.dir, f)}>Open in editor</a>
            <button className="link-btn" onClick={() => void navigator.clipboard?.writeText(`${view.dir}/${f}`)}>Copy path</button>
          </div>
        ))}
      </TokenSection>
    </div>
  );
}

function TokenSection({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="ds-section">
      <h4>
        {title}
        {action}
      </h4>
      {children}
    </section>
  );
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

/** Streams an import and reports its progress. */
function useImport(onImported: (name: string) => void) {
  const [status, setStatus] = useState<{ running: boolean; text: string; sources: string[]; error: string | null }>({
    running: false,
    text: "",
    sources: [],
    error: null,
  });
  const run = async (url: string, body: unknown) => {
    setStatus({ running: true, text: "", sources: [], error: null });
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok || !res.body) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        setStatus((s) => ({ ...s, running: false, error: b?.error ?? `The import failed: ${res.status}` }));
        return;
      }
      let done = false;
      for await (const e of readEvents<ImportStreamEvent>(res.body)) {
        if (e.type === "sources") setStatus((s) => ({ ...s, sources: e.files }));
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
      setStatus((s) => ({ ...s, running: false, error: `The import failed: ${(e as Error).message}` }));
    }
  };
  return { status, run };
}

function ImportProgress({ status }: { status: ReturnType<typeof useImport>["status"] }) {
  if (!status.running && !status.error && !status.text) return null;
  return (
    <div className="import-progress" role="status">
      {status.sources.length > 0 && <p className="muted">Read {status.sources.join(", ")}</p>}
      {status.running && <p className="msg-info">The extract model is writing the design system. This can take a minute or two…</p>}
      {status.text && <p className="variant-text">{status.text}</p>}
      {status.error && (
        <div className="notice notice-danger" role="alert">
          <Icon name="alert" />
          <span>{status.error}</span>
        </div>
      )}
    </div>
  );
}

function RepoImport({ onImported }: { onImported: (name: string) => void }) {
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const { status, run } = useImport(onImported);
  const valid = NAME.test(name) && repo.startsWith("/");
  return (
    <form
      className="import-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !status.running) void run("/api/design-systems/import", { name, repo });
      }}
    >
      <h3>Import from a repo</h3>
      <p className="muted">
        doi reads the theme files, stylesheets with tokens and main components of a local repo, and the extract model writes a design system from them. The repo is not changed.
      </p>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-product" spellCheck={false} />
      </label>
      <label>
        Repo folder (absolute path)
        <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="/home/me/code/my-product" spellCheck={false} />
      </label>
      {name && !NAME.test(name) && <p className="composer-image-error">Use a-z, 0-9 and "-".</p>}
      <button className="btn btn-primary" disabled={!valid || status.running}>Import</button>
      <ImportProgress status={status} />
    </form>
  );
}

function ScreenshotImport({ onImported }: { onImported: (name: string) => void }) {
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const { status, run } = useImport(onImported);
  const valid = NAME.test(name) && images.length > 0;

  const add = async (files: File[]) => {
    setImageError(null);
    const out: PreparedImage[] = [];
    for (const f of files.slice(0, IMAGE_LIMITS.count - images.length)) {
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
    >
      <h3>Import from screenshots</h3>
      <p className="muted">The extract model reads colors, type, spacing and components from 1 to {IMAGE_LIMITS.count} screenshots of one product. It needs a model with vision.</p>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-product" spellCheck={false} />
      </label>
      <label>
        Screenshots
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          onChange={(e) => {
            void add([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </label>
      {images.length > 0 && (
        <div className="composer-images">
          {images.map((img, i) => (
            <span key={i} className="composer-thumb">
              <img src={img.url} alt={`Screenshot ${i + 1}`} />
              <button type="button" className="chip-close" aria-label={`Remove screenshot ${i + 1}`} onClick={() => setImages((l) => l.filter((_, j) => j !== i))}>
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {imageError && <p className="composer-image-error">{imageError}</p>}
      <label>
        Notes (optional)
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="For example: the brand font is Inter." />
      </label>
      {name && !NAME.test(name) && <p className="composer-image-error">Use a-z, 0-9 and "-".</p>}
      <button className="btn btn-primary" disabled={!valid || status.running}>Import</button>
      <ImportProgress status={status} />
    </form>
  );
}
