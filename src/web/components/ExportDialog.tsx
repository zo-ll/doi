import { useEffect, useRef, useState } from "react";
import { getJSON } from "../api.ts";
import { exportUrl, fallbackName, formatSize, runExport, type ExportChoice, type ExportFormat, type ExportReport } from "../export.ts";
import type { Frame } from "../../workspace/frames.ts";
import { MOD } from "./TopBar.tsx";

const FORMATS: { id: ExportFormat; title: string; sub: string }[] = [
  { id: "folder", title: "Folder", sub: "ZIP" },
  { id: "page", title: "HTML", sub: "Single file" },
  { id: "png", title: "PNG", sub: "Images" },
  { id: "pdf", title: "PDF", sub: "Page per slide" },
];
const NOTE: Record<ExportFormat, string> = {
  folder: "All pages and files, with the design system files they link.",
  page: "index.html with its CSS, scripts, images and fonts inline. Links to other pages do not work.",
  png: "A picture of each chosen frame. More than one frame gives a ZIP.",
  pdf: "A deck gives one page per slide. Other designs give one page as wide as the frame and as high as the whole design.",
};

type Done = ExportReport & { file: string; size: number };

/** Export of the open design (#46, #47, #48): a folder, one HTML file, PNG or PDF. */
export function ExportDialog({ project, design, onClose }: { project: string; design: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [choice, setChoice] = useState<ExportChoice>({ format: "folder", stripOids: false, frame: "all", scale: 2, fullPage: false });
  const [frames, setFrames] = useState<Frame[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const abort = useRef<AbortController | null>(null);
  const set = (patch: Partial<ExportChoice>) => {
    setChoice((c) => ({ ...c, ...patch }));
    setDone(null);
    setError(null);
  };

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") running ? abort.current?.abort() : onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, running]);
  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    let live = true;
    getJSON<Frame[]>(`/api/projects/${project}/designs/${design}/layout`)
      .then((f) => live && setFrames(f))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [project, design]);

  // "All frames" is a PNG choice only. A PDF shows one frame: the first one by default.
  const frame = choice.format === "pdf" && choice.frame === "all" ? (frames?.[0]?.id ?? "all") : choice.frame;
  const effective: ExportChoice = { ...choice, frame };
  const rendered = choice.format === "png" || choice.format === "pdf";
  const pngCount = choice.format === "png" ? (frame === "all" ? (frames?.length ?? 0) : 1) : 0;
  const action =
    choice.format === "folder" ? "Export ZIP" : choice.format === "page" ? "Export HTML" : choice.format === "pdf" ? "Export PDF" : pngCount > 1 ? `Export ${pngCount} PNGs` : "Export PNG";

  const start = async () => {
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setError(null);
    setDone(null);
    try {
      setDone(await runExport(exportUrl(project, design, effective), fallbackName(design, effective), { signal: controller.signal }));
    } catch (e) {
      setError(controller.signal.aborted ? "Stopped. Nothing was saved." : (e as Error).message);
    } finally {
      setRunning(false);
      abort.current = null;
    }
  };

  const frameLabel = (f: Frame) => f.label;

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="dialog export-dialog" role="dialog" aria-modal="true" aria-label="Export" tabIndex={-1} ref={ref}>
        <form
          className="export-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (done) onClose();
            else if (!running) void start();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !running && !done) {
              e.preventDefault();
              void start();
            }
          }}
        >
          <div className="dialog-head">
            <h2>Export {design}</h2>
            <span className="spacer" />
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)" disabled={running}>
              ×
            </button>
          </div>

          <div className="export-body">
            <div className="format-cards" role="radiogroup" aria-label="Format">
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={choice.format === f.id}
                  className="format-card"
                  disabled={running}
                  onClick={() => set({ format: f.id })}
                >
                  <span className="format-title">{f.title}</span>
                  <span className="format-sub">{f.sub}</span>
                </button>
              ))}
            </div>
            <p className="export-note">{NOTE[choice.format]}</p>

            {rendered && (
              <div className="export-options">
                <div className="option-row">
                  <span className="option-label">{choice.format === "pdf" ? "Frame" : "Frames"}</span>
                  <div className="seg" role="radiogroup" aria-label="Frames">
                    {choice.format === "png" && (
                      <button type="button" className="seg-item" role="radio" aria-checked={frame === "all"} disabled={!frames || running} onClick={() => set({ frame: "all" })}>
                        All · {frames?.length ?? "…"}
                      </button>
                    )}
                    {frames?.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        className="seg-item"
                        role="radio"
                        aria-checked={frame === f.id}
                        disabled={running}
                        onClick={() => set({ frame: f.id })}
                        title={`${f.width} × ${f.height}`}
                      >
                        {frameLabel(f)}
                      </button>
                    ))}
                  </div>
                </div>
                {choice.format === "png" && (
                  <>
                    <div className="option-row">
                      <span className="option-label">Scale</span>
                      <div className="seg" role="radiogroup" aria-label="Scale">
                        {([1, 2] as const).map((s) => (
                          <button key={s} type="button" className="seg-item" role="radio" aria-checked={choice.scale === s} disabled={running} onClick={() => set({ scale: s })}>
                            {s}×
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="option-row">
                      <span className="option-label">Area</span>
                      <div className="seg" role="radiogroup" aria-label="Area">
                        <button type="button" className="seg-item" role="radio" aria-checked={!choice.fullPage} disabled={running} onClick={() => set({ fullPage: false })}>
                          Viewport
                        </button>
                        <button type="button" className="seg-item" role="radio" aria-checked={choice.fullPage} disabled={running} onClick={() => set({ fullPage: true })}>
                          Whole page
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {!rendered && (
              <label className="check-card">
                <input type="checkbox" checked={choice.stripOids} disabled={running} onChange={(e) => set({ stripOids: e.target.checked })} />
                <span>
                  <span className="check-title">Remove element ids</span>
                  <span className="check-sub">Strips data-oid from the HTML. Keep them for a handoff: comments name elements by them.</span>
                </span>
              </label>
            )}

            {running && (
              <div className="export-progress" role="status">
                <span className="spinner" />
                {rendered ? `Rendering ${choice.format.toUpperCase()}…` : "Packing the files…"}
              </div>
            )}
            {error && (
              <div className="banner banner-err" role="alert">
                <span className="dot dot-err" />
                {error}
              </div>
            )}
            {done && <ExportResult done={done} />}
          </div>

          <div className="dialog-foot">
            <span className="spacer" />
            {running ? (
              <button type="button" className="btn btn-secondary" onClick={() => abort.current?.abort()}>
                <span className="stop-square" />
                Stop
              </button>
            ) : done ? (
              <button className="btn btn-primary">Done</button>
            ) : (
              <>
                <button type="button" className="btn btn-ghost" onClick={onClose}>
                  Cancel
                </button>
                <button className="btn btn-primary" disabled={rendered && !frames} title={`${action} (${MOD}↵)`}>
                  {action}
                  <span className="kbd">{MOD}↵</span>
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

/** The saved file and the report: missing files and warnings. */
export function ExportResult({ done }: { done: Done }) {
  return (
    <div className="export-result" role="status">
      <p className="export-result-head">
        <span className={`dot ${done.missing.length || done.warnings.length ? "dot-warn" : "dot-ok"}`} />
        <strong>Saved {done.file}</strong>
        <span className="mono muted">{formatSize(done.size)} · in your browser's downloads</span>
      </p>
      {(done.missing.length > 0 || done.warnings.length > 0) && (
        <div className="report-list">
          {done.missing.map((m) => (
            <div key={m} className="report-item">
              <span className="dot dot-err" />
              <div>
                <p>Missing file</p>
                <p className="mono muted">{m}</p>
              </div>
            </div>
          ))}
          {done.warnings.map((w) => (
            <div key={w} className="report-item">
              <span className="dot dot-warn" />
              <p>{w}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
