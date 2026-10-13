import { useEffect, useRef, useState } from "react";
import { exportUrl, runExport, type ExportFormat, type ExportReport } from "../export.ts";
import { Icon } from "./Icon.tsx";

/** Export of the open design (#46): a ZIP folder or one HTML file, with or without data-oid. */
export function ExportDialog({ project, design, onClose }: { project: string; design: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [format, setFormat] = useState<ExportFormat>("folder");
  const [stripOids, setStripOids] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<(ExportReport & { file: string }) | null>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const start = async () => {
    setRunning(true);
    setError(null);
    setDone(null);
    try {
      setDone(await runExport(exportUrl(project, design, format, stripOids), `${design}.${format === "folder" ? "zip" : "html"}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

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
            if (!running) void start();
          }}
        >
          <fieldset className="export-choices">
            <legend>Format</legend>
            <label className="export-choice">
              <input type="radio" name="format" checked={format === "folder"} onChange={() => setFormat("folder")} />
              <span>
                <span className="export-choice-title">Folder (.zip)</span>
                <span className="muted">All pages and files, with the design system files they link.</span>
              </span>
            </label>
            <label className="export-choice">
              <input type="radio" name="format" checked={format === "page"} onChange={() => setFormat("page")} />
              <span>
                <span className="export-choice-title">Single HTML file</span>
                <span className="muted">index.html with its CSS, scripts, images and fonts inline. Links to other pages do not work.</span>
              </span>
            </label>
          </fieldset>
          <label className="export-choice">
            <input type="checkbox" checked={stripOids} onChange={(e) => setStripOids(e.target.checked)} />
            <span>
              <span className="export-choice-title">Remove data-oid attributes</span>
              <span className="muted">doi needs them for selection and comments. The exported page does not.</span>
            </span>
          </label>

          {error && (
            <div className="notice notice-danger" role="alert">
              <Icon name="alert" size={14} />
              <span className="notice-text">{error}</span>
            </div>
          )}
          {done && (
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
            <button type="submit" className="btn btn-primary" disabled={running}>
              {running ? "Exporting…" : "Export"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
