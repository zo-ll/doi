import { useEffect, useRef, useState } from "react";
import { designUrl } from "../api.ts";
import { parseFrameMessage, trackMessage, type Rect } from "../frame.ts";
import type { Active } from "./Sidebar.tsx";
import type { Selection } from "./ChatPanel.tsx";
import { Icon } from "./Icon.tsx";

const FRAMES = [
  { id: "desktop", label: "Desktop", width: 1440, height: 900 },
  { id: "mobile", label: "Mobile", width: 390, height: 844 },
];
const ZOOM_STEPS = [0.25, 0.33, 0.4, 0.5, 0.67, 0.75, 1];
const DEFAULT_ZOOM = 0.4;

type FrameState = "loading" | "ready" | "error";

/** Screen pixels above a box for its tag. With less room, the tag goes inside the box. */
const TAG_ROOM = 24;
const boxStyle = (r: Rect) => ({ left: r.x, top: r.y, width: r.width, height: r.height });

function Frame({ src, label, width, height, zoom, selection, onSelect, onClear }: {
  src: string;
  label: string;
  width: number;
  height: number;
  zoom: number;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  onClear: () => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<FrameState>("loading");
  const [rects, setRects] = useState<{ selected: Rect | null; hover: { oid: string; rect: Rect } | null }>({
    selected: null,
    hover: null,
  });
  const oid = selection?.oid ?? null;
  const oidRef = useRef(oid);
  oidRef.current = oid;

  // An iframe cannot report an HTTP error, so check the page before showing it.
  useEffect(() => {
    let live = true;
    setState("loading");
    fetch(src, { method: "HEAD" })
      .then((r) => live && !r.ok && setState("error"))
      .catch(() => live && setState("error"));
    return () => { live = false; };
  }, [src]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== ref.current?.contentWindow) return;
      const m = parseFrameMessage(event.data);
      if (m?.type === "doi:select") onSelect({ oid: m.oid });
      else if (m?.type === "doi:clear") onClear();
      else if (m?.type === "doi:rects") setRects({ selected: m.selected, hover: m.hover });
      // A page that loaded again asks which element is selected.
      else if (m?.type === "doi:ready") ref.current?.contentWindow?.postMessage(trackMessage(oidRef.current), "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onSelect, onClear]);

  // Every frame of the design shows the selection, in its own layout.
  useEffect(() => {
    if (!oid) setRects((r) => ({ ...r, selected: null }));
    ref.current?.contentWindow?.postMessage(trackMessage(oid), "*");
  }, [oid]);

  // A new page has no rects until its bridge reports them.
  useEffect(() => setRects({ selected: null, hover: null }), [src]);

  return (
    <figure className="frame">
      <figcaption className="frame-label">
        <span>{label}</span>
        <span className="muted">{width} × {height}</span>
      </figcaption>
      <div className="frame-surface" style={{ width: width * zoom, height: height * zoom }}>
        {state === "error" ? (
          <div className="frame-state">
            <Icon name="alert" size={20} />
            <p>This design cannot load.</p>
          </div>
        ) : (
          <div
            className="frame-scale"
            style={{ width, height, transform: `scale(${zoom})`, "--zoom": zoom } as React.CSSProperties}
          >
            <iframe
              ref={ref}
              src={src}
              title={`${label} preview`}
              sandbox="allow-scripts"
              width={width}
              height={height}
              onLoad={() => setState((s) => (s === "error" ? s : "ready"))}
            />
            <div className="frame-overlay">
              {rects.hover && <div className="hover-box" style={boxStyle(rects.hover.rect)} />}
              {oid && rects.selected && (
                <div
                  className={`selection-box${rects.selected.y < TAG_ROOM / zoom ? " tag-inside" : ""}`}
                  style={boxStyle(rects.selected)}
                >
                  <span className="selection-tag">{oid}</span>
                </div>
              )}
            </div>
          </div>
        )}
        {state === "loading" && <div className="frame-loading skeleton" aria-label="Loading design" />}
      </div>
    </figure>
  );
}

export function Canvas({ active, revision, selection, onSelect, onClear }: {
  active: Active | null;
  /** Changes when the design files changed; the frames load again. */
  revision: number;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  onClear: () => void;
}) {
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const step = (dir: 1 | -1) => {
    const i = ZOOM_STEPS.findIndex((z) => z >= zoom - 1e-6);
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i === -1 ? ZOOM_STEPS.length - 1 : i) + dir))];
    if (next !== undefined) setZoom(next);
  };

  if (!active) {
    return (
      <main className="canvas canvas-empty">
        <div className="empty">
          <Icon name="frame" size={24} />
          <h2>No design open</h2>
          <p>Select a design in the sidebar.</p>
        </div>
      </main>
    );
  }

  const src = `${designUrl(active.project, active.design)}?v=${revision}`;
  return (
    <main className="canvas" aria-label="Canvas">
      <div className="canvas-scroll">
        <div className="canvas-frames">
          {FRAMES.map((f) => (
            <Frame key={f.id} src={src} {...f} zoom={zoom} selection={selection} onSelect={onSelect} onClear={onClear} />
          ))}
        </div>
      </div>

      <div className="canvas-toolbar" role="toolbar" aria-label="Zoom">
        <button className="icon-btn" onClick={() => step(-1)} aria-label="Zoom out" disabled={zoom <= ZOOM_STEPS[0]!}>
          <Icon name="minus" />
        </button>
        <span className="zoom-value">{Math.round(zoom * 100)}%</span>
        <button className="icon-btn" onClick={() => step(1)} aria-label="Zoom in" disabled={zoom >= ZOOM_STEPS.at(-1)!}>
          <Icon name="plus" />
        </button>
        <span className="toolbar-sep" />
        <button className="icon-btn" onClick={() => setZoom(DEFAULT_ZOOM)} aria-label="Reset zoom" title="Reset zoom">
          <Icon name="fit" />
        </button>
      </div>
    </main>
  );
}
