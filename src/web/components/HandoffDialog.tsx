import { useEffect, useRef, useState } from "react";
import { getJSON } from "../api.ts";
import { bundleRequest, runExport, type ExportReport } from "../export.ts";
import { ExportResult } from "./ExportDialog.tsx";

type Tab = "prompt" | "zip";

/**
 * Hand off to a coding agent (#53): a prompt for any agent, which reads the design through the
 * doi MCP server, or a ZIP bundle for agents that cannot reach doi and for people.
 */
export function HandoffDialog({ project, design, version, pages, openComments, hasDesignSystem, onClose }: {
  project: string;
  design: string;
  /** The count of versions; null while unknown. */
  version: number | null;
  pages: number;
  openComments: number;
  hasDesignSystem: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>("prompt");
  const [defaults, setDefaults] = useState<{ prompt: string; url: string } | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<string | null>(null);
  const [copied, setCopied] = useState<null | "url" | "prompt">(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<(ExportReport & { file: string; size: number }) | null>(null);
  const [frames, setFrames] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const base = `/api/projects/${project}/designs/${design}/handoff`;

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
    getJSON<unknown[]>(`/api/projects/${project}/designs/${design}/layout`)
      .then((f) => setFrames(f.length))
      .catch(() => {}); // only the footer and the checklist count frames
    getJSON<{ prompt: string; url: string }>(`${base}/prompt`)
      .then((r) => {
        setDefaults(r);
        setPrompt(r.prompt);
      })
      .catch((e: Error) => setError(e.message));
  }, [base]);
  useEffect(() => {
    if (tab !== "zip" || handoff !== null) return;
    getJSON<{ markdown: string }>(base)
      .then((r) => setHandoff(r.markdown))
      .catch((e: Error) => setError(e.message));
  }, [tab, handoff, base]);

  const copy = async (what: "url" | "prompt", text: string) => {
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setError("The browser did not allow the copy. Select the text and copy it.");
    }
  };

  const download = async () => {
    if (!handoff?.trim()) return;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setError(null);
    setDone(null);
    try {
      const { url, init } = bundleRequest(project, design, handoff);
      setDone(await runExport(url, `${design}-handoff.zip`, { ...init, signal: controller.signal }));
    } catch (e) {
      setError(controller.signal.aborted ? "Stopped. Nothing was saved." : (e as Error).message);
    } finally {
      setRunning(false);
      abort.current = null;
    }
  };

  const shots = Math.min(pages * frames, 24);
  const inZip: { label: string; on: boolean }[] = [
    { label: "HANDOFF.md", on: true },
    { label: `Pages · ${pages}`, on: true },
    { label: `Screenshots · ${shots}`, on: shots > 0 },
    { label: hasDesignSystem ? "tokens.css (design system)" : "tokens.css (if the design has tokens)", on: true },
    { label: `Open comments · ${openComments}`, on: openComments > 0 },
  ];

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="dialog handoff-dialog" role="dialog" aria-modal="true" aria-label="Hand off" tabIndex={-1} ref={ref}>
        <div className="handoff-inner">
          <div className="dialog-head">
            <h2>Hand off {design}</h2>
            <span className="spacer" />
            <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)" disabled={running}>
              ×
            </button>
          </div>
          <div className="tabs handoff-tabs" role="tablist">
            <button className="tab" role="tab" aria-selected={tab === "prompt"} onClick={() => setTab("prompt")}>
              Prompt for a coding agent
            </button>
            <button className="tab" role="tab" aria-selected={tab === "zip"} onClick={() => setTab("zip")}>
              Handoff bundle (ZIP)
            </button>
          </div>

          {error && (
            <div className="banner banner-err handoff-error" role="alert">
              <span className="dot dot-err" />
              {error}
            </div>
          )}

          {tab === "prompt" && (
            <div className="handoff-body">
              <div className="mcp-row">
                <span className="dot dot-ok" />
                <span>MCP server running</span>
                <span className="mono mcp-url">{defaults?.url ?? "…"}</span>
                <span className="spacer" />
                <button className="btn btn-secondary btn-md" disabled={!defaults} onClick={() => defaults && void copy("url", defaults.url)}>
                  {copied === "url" ? "Copied" : "Copy URL"}
                </button>
              </div>
              <div className="mcp-hint">
                <p>Add this URL to your agent once, as an MCP server with the Streamable HTTP transport. Any agent with an MCP client works.</p>
                <p className="muted">The agent reads the design from doi, so keep doi running while it works.</p>
              </div>
              <div className="field-head">
                <span>Prompt · editable</span>
                <span className="spacer" />
                <button className="link-btn" disabled={!defaults || prompt === defaults.prompt} onClick={() => defaults && setPrompt(defaults.prompt)}>
                  Reset to default
                </button>
              </div>
              <textarea
                className="textarea handoff-text"
                value={prompt ?? "Loading…"}
                readOnly={prompt === null}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  setCopied(null);
                }}
                aria-label="Prompt"
              />
            </div>
          )}

          {tab === "zip" && (
            <div className="handoff-body handoff-zip">
              <div className="handoff-md">
                <div className="field-head">
                  <span>HANDOFF.md · editable</span>
                  <span className="spacer" />
                  <span className="muted">For cloud agents or people</span>
                </div>
                <textarea
                  className="textarea handoff-text"
                  value={handoff ?? "Loading…"}
                  readOnly={handoff === null || running}
                  onChange={(e) => {
                    setHandoff(e.target.value);
                    setDone(null);
                  }}
                  aria-label="HANDOFF.md"
                />
                {running && (
                  <div className="export-progress" role="status">
                    <span className="spinner" />
                    Rendering the screenshots and packing the bundle…
                  </div>
                )}
                {done && <ExportResult done={done} />}
              </div>
              <div className="in-zip">
                <h4>In the ZIP</h4>
                {inZip.map((i) => (
                  <p key={i.label} className={i.on ? "" : "is-off"}>
                    <span className="in-zip-mark">{i.on ? "✓" : "–"}</span>
                    {i.label}
                  </p>
                ))}
                <p className="is-off">
                  <span className="in-zip-mark">–</span>Chat history
                </p>
              </div>
            </div>
          )}

          <div className="dialog-foot">
            {tab === "prompt" ? (
              <>
                <span className="muted">
                  {version ? `Uses v${version} · ` : ""}
                  {pages} page{pages === 1 ? "" : "s"} · {frames} frame{frames === 1 ? "" : "s"}
                </span>
                <span className="spacer" />
                {copied === "prompt" && <span className="status">Copied. Paste it into your agent.</span>}
                <button className="btn btn-primary" disabled={!prompt} onClick={() => prompt && void copy("prompt", prompt)}>
                  Copy prompt
                </button>
              </>
            ) : (
              <>
                <span className="mono muted">{design}-handoff.zip</span>
                <span className="spacer" />
                {running ? (
                  <button className="btn btn-secondary" onClick={() => abort.current?.abort()}>
                    <span className="stop-square" />
                    Stop
                  </button>
                ) : (
                  <button className="btn btn-primary" disabled={!handoff?.trim()} onClick={() => void download()}>
                    Download ZIP
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
