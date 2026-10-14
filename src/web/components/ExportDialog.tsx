import { useEffect, useRef, useState } from "react";
import { getJSON } from "../api.ts";
import { exportUrl, fallbackName, runExport, type ExportChoice, type ExportFormat, type ExportReport } from "../export.ts";
import type { Frame } from "../../workspace/frames.ts";
import { Icon } from "./Icon.tsx";

/** "prompt" is not a file: it is the text for a coding agent (#53, #54). */
type Choice = ExportFormat | "prompt";

const FORMATS: { id: Choice; title: string; text: string }[] = [
  { id: "folder", title: "Folder (.zip)", text: "All pages and files, with the design system files they link." },
  { id: "page", title: "Single HTML file", text: "index.html with its CSS, scripts, images and fonts inline. Links to other pages do not work." },
  { id: "png", title: "PNG", text: "A picture of one frame, or a ZIP with one picture per frame." },
  { id: "pdf", title: "PDF", text: "A deck gives one page per slide. Other designs give one page as wide as the frame and as high as the whole design." },
  { id: "prompt", title: "Prompt for a coding agent", text: "Paste it into any agent in your repo. The agent reads the design through the doi MCP server while doi runs." },
];

/** Export of the open design (#46, #47, #48): files, one HTML file, PNG or PDF, or the agent prompt. */
export function ExportDialog({ project, design, onClose }: { project: string; design: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [choice, setChoice] = useState<ExportChoice>({ format: "folder", stripOids: false, frame: "all", scale: 2, fullPage: false });
  const [frames, setFrames] = useState<Frame[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<(ExportReport & { file: string }) | null>(null);
  const [kind, setKind] = useState<Choice>("folder");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const set = (patch: Partial<ExportChoice>) => setChoice((c) => ({ ...c, ...patch }));

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    getJSON<Frame[]>(`/api/projects/${project}/designs/${design}/layout`)
      .then(setFrames)
      .catch((e: Error) => setError(e.message));
  }, [project, design]);

  // "All frames" is a PNG choice only. A PDF shows one frame: the first one, also when the
  // frames were not loaded yet when PDF was picked.
  const frame = choice.format === "pdf" && choice.frame === "all" ? (frames?.[0]?.id ?? "all") : choice.frame;
  const effective: ExportChoice = { ...choice, frame };

  const start = async () => {
    setRunning(true);
    setError(null);
    setDone(null);
    try {
      setDone(await runExport(exportUrl(project, design, effective), fallbackName(design, effective)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    if (kind !== "prompt" || prompt !== null) return;
    getJSON<{ prompt: string }>(`/api/projects/${project}/designs/${design}/handoff/prompt`)
      .then((r) => setPrompt(r.prompt))
      .catch((e: Error) => setError(e.message));
  }, [kind, prompt, project, design]);

  const copy = async () => {
    if (prompt === null) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
    } catch {
      setError("The browser did not allow the copy. Select the text and copy it.");
    }
  };

  const isPrompt = kind === "prompt";
  const rendered = !isPrompt && (choice.format === "png" || choice.format === "pdf");

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="export-dialog" role="dialog" aria-modal="true" aria-label="Export" tabIndex={-1} ref={ref}>
        <header className="ds-head">
          <h2>Export</h2>
          <span className="muted truncate">
            {project} / {design}
          </span>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <Icon name="close" />
          </button>
        </header>
        <form
          className="export-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (isPrompt) void copy();
            else if (!running) void start();
          }}
        >
          <fieldset className="export-choices">
            <legend>Format</legend>
            {FORMATS.map((f) => (
              <label key={f.id} className="export-choice">
                <input
                  type="radio"
                  name="format"
                  checked={kind === f.id}
                  onChange={() => {
                    setKind(f.id);
                    setError(null);
                    setCopied(false);
                    if (f.id !== "prompt") set({ format: f.id });
                  }}
                />
                <span>
                  <span className="export-choice-title">{f.title}</span>
                  <span className="muted">{f.text}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {isPrompt && (
            <label className="export-field">
              Prompt
              <textarea
                className="export-prompt"
                value={prompt ?? "Loading…"}
                readOnly={prompt === null}
                rows={12}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  setCopied(false);
                }}
              />
            </label>
          )}

          {!rendered && !isPrompt && (
            <label className="export-choice">
              <input type="checkbox" checked={choice.stripOids} onChange={(e) => set({ stripOids: e.target.checked })} />
              <span>
                <span className="export-choice-title">Remove data-oid attributes</span>
                <span className="muted">doi needs them for selection and comments. The exported page does not.</span>
              </span>
            </label>
          )}

          {rendered && (
            <div className="export-options">
              <label className="export-field">
                Frame
                <select value={frame} onChange={(e) => set({ frame: e.target.value })} disabled={!frames}>
                  {choice.format === "png" && <option value="all">All frames</option>}
                  {frames?.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label} ({f.width} × {f.height})
                    </option>
                  ))}
                </select>
              </label>
              {choice.format === "png" && (
                <>
                  <label className="export-field">
                    Scale
                    <select value={choice.scale} onChange={(e) => set({ scale: e.target.value === "1" ? 1 : 2 })}>
                      <option value="1">1×</option>
                      <option value="2">2× (sharp on high-density screens)</option>
                    </select>
                  </label>
                  <label className="export-choice">
                    <input type="checkbox" checked={choice.fullPage} onChange={(e) => set({ fullPage: e.target.checked })} />
                    <span>
                      <span className="export-choice-title">Whole page</span>
                      <span className="muted">The full height of the design, not only the frame.</span>
                    </span>
                  </label>
                </>
              )}
            </div>
          )}

          {error && (
            <div className="notice notice-danger" role="alert">
              <Icon name="alert" size={14} />
              <span className="notice-text">{error}</span>
            </div>
          )}
          {copied && (
            <div className="export-result" role="status">
              <p>
                <Icon name="check" size={14} />
                <span>Copied. Keep doi running while the agent works.</span>
              </p>
            </div>
          )}
          {done && !isPrompt && (
            <div className="export-result" role="status">
              <p>
                <Icon name="check" size={14} />
                <span>
                  Saved <code>{done.file}</code>.
                </span>
              </p>
              {(done.missing.length > 0 || done.warnings.length > 0) && (
                <div className="composer-warning">
                  <Icon name="alert" size={14} />
                  <div>
                    {done.warnings.map((w) => (
                      <p key={w}>{w}</p>
                    ))}
                    {done.missing.length > 0 && (
                      <p>
                        Files not found: {done.missing.map((m, i) => (
                          <span key={m}>
                            {i > 0 && ", "}
                            <code>{m}</code>
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="export-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Close
            </button>
            {isPrompt ? (
              <button type="submit" className="btn btn-primary" disabled={prompt === null}>
                Copy prompt
              </button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={running || (rendered && !frames)}>
                {running ? "Exporting…" : "Export"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
