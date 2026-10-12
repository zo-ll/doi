import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { designUrl, getJSON, sendJSON } from "../api.ts";
import type { Pin } from "../comments.ts";
import { parseFrameMessage, trackMessage, type FrameMessage, type Rect } from "../frame.ts";
import {
  arrangeRow,
  fitView,
  newFrameId,
  nextPosition,
  stepZoom,
  wheelFactor,
  zoomAt,
  ZOOM_MAX,
  ZOOM_MIN,
  type Point,
  type View,
} from "../viewport.ts";
import { FRAME_LIMITS, PRESETS, type Frame as FrameSpec } from "../../workspace/frames.ts";
import type { Active } from "./Sidebar.tsx";
import type { Selection } from "./ChatPanel.tsx";
import { Icon } from "./Icon.tsx";

type FrameState = "loading" | "ready" | "error";
type WheelMessage = Extract<FrameMessage, { type: "doi:wheel" }>;
type KeyMessage = Extract<FrameMessage, { type: "doi:key" }>;

/** Screen pixels above a box for its tag. With less room, the tag goes inside the box. */
const TAG_ROOM = 24;
/** Screen pixels that one arrow key pans; with Shift, four times as many. */
const ARROW_STEP = 64;
const boxStyle = (r: Rect) => ({ left: r.x, top: r.y, width: r.width, height: r.height });
const layoutUrl = (a: Active) => `/api/projects/${a.project}/designs/${a.design}/layout`;

/** True while the user types in a field of the app: canvas keys do nothing then. */
const typing = (t: EventTarget | null) =>
  t instanceof Element && t.closest("input, textarea, select, [contenteditable]") !== null;

const Frame = memo(function Frame({
  frame,
  src,
  zoom,
  selection,
  pins,
  canRemove,
  onSelect,
  onClear,
  onPin,
  onRemove,
  onMoveStart,
  onWheel,
  onKey,
}: {
  frame: FrameSpec;
  src: string;
  zoom: number;
  selection: Selection | null;
  pins: Pin[];
  canRemove: boolean;
  onSelect: (s: Selection) => void;
  onClear: () => void;
  onPin: (oid: string) => void;
  onRemove: (id: string) => void;
  onMoveStart: (e: React.PointerEvent, id: string) => void;
  onWheel: (frame: FrameSpec, m: WheelMessage) => void;
  onKey: (m: KeyMessage) => void;
}) {
  const { width, height, label } = frame;
  const ref = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<FrameState>("loading");
  const [rects, setRects] = useState<{
    selected: Rect | null;
    hover: { oid: string; rect: Rect } | null;
    pins: Record<string, Rect>;
  }>({ selected: null, hover: null, pins: {} });
  const oid = selection?.oid ?? null;
  // One string, so the effect below runs only when the set of pinned elements changes.
  const pinKey = pins.map((p) => p.oid).join(" ");
  const track = useRef(trackMessage(null));
  track.current = trackMessage(oid, pinKey ? pinKey.split(" ") : []);
  // The latest frame and handlers, so the message listener stays the same while the frame moves.
  const latest = useRef({ frame, onSelect, onClear, onWheel, onKey });
  latest.current = { frame, onSelect, onClear, onWheel, onKey };

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
      const h = latest.current;
      if (m?.type === "doi:select") h.onSelect({ oid: m.oid });
      else if (m?.type === "doi:clear") h.onClear();
      else if (m?.type === "doi:rects") setRects({ selected: m.selected, hover: m.hover, pins: m.pins });
      else if (m?.type === "doi:wheel") h.onWheel(h.frame, m);
      else if (m?.type === "doi:key") h.onKey(m);
      // A page that loaded again asks which element is selected and which have pins.
      else if (m?.type === "doi:ready") ref.current?.contentWindow?.postMessage(track.current, "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Every frame of the design shows the selection and the pins, in its own layout.
  useEffect(() => {
    if (!oid) setRects((r) => ({ ...r, selected: null }));
    ref.current?.contentWindow?.postMessage(track.current, "*");
  }, [oid, pinKey]);

  // A new page has no rects until its bridge reports them.
  useEffect(() => setRects({ selected: null, hover: null, pins: {} }), [src]);

  return (
    <figure className="frame" style={{ left: frame.x, top: frame.y, width, height }}>
      <figcaption className="frame-label" onPointerDown={(e) => onMoveStart(e, frame.id)} title="Drag to move the frame">
        <span className="truncate">{label}</span>
        <span className="muted">{width} × {height}</span>
        {canRemove && (
          <button
            className="frame-remove"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onRemove(frame.id)}
            aria-label={`Remove frame ${label}`}
            title="Remove frame"
          >
            <Icon name="close" size={12} />
          </button>
        )}
      </figcaption>
      <div className="frame-surface">
        {state === "error" ? (
          <div className="frame-state">
            <Icon name="alert" size={20} />
            <p>This design cannot load.</p>
          </div>
        ) : (
          <>
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
              {pins.map((p) => {
                // Own keys only: the first state is a plain object, and an id may be "__proto__".
                const r = Object.hasOwn(rects.pins, p.oid) ? rects.pins[p.oid] : null;
                if (!r) return null;
                const numbers = p.numbers.join(", ");
                return (
                  <button
                    key={p.oid}
                    className="pin"
                    style={{ left: r.x + r.width, top: r.y }}
                    onClick={() => onPin(p.oid)}
                    aria-label={`Comment ${numbers} on ${p.oid}`}
                    title={`Comment ${numbers}`}
                  >
                    {numbers}
                  </button>
                );
              })}
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
          </>
        )}
        {state === "loading" && <div className="frame-loading skeleton" aria-label="Loading design" />}
      </div>
    </figure>
  );
});

/** The "Add frame" menu: the presets, or a custom size. */
function AddFrameMenu({ onAdd, onClose }: { onAdd: (label: string, width: number, height: number) => void; onClose: () => void }) {
  const [w, setW] = useState("1280");
  const [h, setH] = useState("800");
  const width = Number(w);
  const height = Number(h);
  const valid =
    Number.isInteger(width) && Number.isInteger(height) &&
    width >= FRAME_LIMITS.min && width <= FRAME_LIMITS.maxWidth &&
    height >= FRAME_LIMITS.min && height <= FRAME_LIMITS.maxHeight;
  return (
    <div className="add-frame-menu" role="dialog" aria-label="Add frame" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      {PRESETS.map((p) => (
        <button key={p.label} className="menu-item" onClick={() => onAdd(p.label, p.width, p.height)}>
          <span>{p.label}</span>
          <span className="muted">{p.width} × {p.height}</span>
        </button>
      ))}
      <form
        className="custom-size"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onAdd(`${width} × ${height}`, width, height);
        }}
      >
        <input aria-label="Custom width" inputMode="numeric" value={w} onChange={(e) => setW(e.target.value)} />
        <span className="muted">×</span>
        <input aria-label="Custom height" inputMode="numeric" value={h} onChange={(e) => setH(e.target.value)} />
        <button className="btn btn-secondary" disabled={!valid}>Add</button>
      </form>
      {!valid && (
        <p className="custom-size-hint">
          Use {FRAME_LIMITS.min} to {FRAME_LIMITS.maxWidth} × {FRAME_LIMITS.min} to {FRAME_LIMITS.maxHeight} pixels.
        </p>
      )}
    </div>
  );
}

type Drag =
  | { kind: "pan"; start: Point; view: View }
  | { kind: "move"; id: string; start: Point; frame: FrameSpec; moved: boolean };

export function Canvas({ active, revision, selection, pins, onSelect, onClear, onPin }: {
  active: Active | null;
  /** Changes when the design files changed; the frames load again. */
  revision: number;
  selection: Selection | null;
  /** Elements with open comments. */
  pins: Pin[];
  onSelect: (s: Selection) => void;
  onClear: () => void;
  onPin: (oid: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [frames, setFrames] = useState<FrameSpec[] | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 0.4 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const needsFit = useRef(true);
  const state = useRef({ view, frames, active });
  state.current = { view, frames, active };

  // Load the frames of the design; a new design fits to the screen once they are there.
  useEffect(() => {
    if (!active) return;
    let live = true;
    setFrames(null);
    setLayoutError(null);
    needsFit.current = true;
    getJSON<FrameSpec[]>(layoutUrl(active))
      .then((f) => live && setFrames(f))
      .catch((e) => {
        if (!live) return;
        setLayoutError(`The frame layout cannot load: ${(e as Error).message}`);
        setFrames([]);
      });
    return () => { live = false; };
  }, [active?.project, active?.design]);

  const size = () => {
    const r = ref.current?.getBoundingClientRect();
    return { width: r?.width ?? 0, height: r?.height ?? 0 };
  };
  const center = (): Point => {
    const s = size();
    return { x: s.width / 2, y: s.height / 2 };
  };
  const fit = useCallback(() => {
    const f = state.current.frames;
    if (f?.length) setView(fitView(f, size()));
  }, []);

  useLayoutEffect(() => {
    if (frames?.length && needsFit.current) {
      needsFit.current = false;
      fit();
    }
  }, [frames, fit]);

  /** Changes the frames and stores them. A failed save shows a message and keeps the change. */
  const changeFrames = useCallback((next: FrameSpec[]) => {
    const a = state.current.active;
    setFrames(next);
    if (!a) return;
    sendJSON("PUT", layoutUrl(a), { frames: next })
      .then(() => setLayoutError(null))
      .catch((e) => setLayoutError(`The frame layout was not saved: ${(e as Error).message}`));
  }, []);

  const zoomTo = (zoom: number, at: Point = center()) => setView((v) => zoomAt(v, zoom, at));

  // Wheel: Ctrl/⌘ or a pinch zooms at the pointer, else it pans. React's wheel handler is
  // passive, so the listener is added here to stop the page zoom.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (e.ctrlKey || e.metaKey) setView((v) => zoomAt(v, v.zoom * wheelFactor(e.deltaY), at));
      else {
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [active !== null]);

  // A pinch over a frame: the bridge sends it with the point in the frame's viewport.
  const onFrameWheel = useCallback((f: FrameSpec, m: WheelMessage) => {
    setView((v) => zoomAt(v, v.zoom * wheelFactor(m.deltaY), { x: (f.x + m.x) * v.zoom + v.x, y: (f.y + m.y) * v.zoom + v.y }));
  }, []);

  const onKey = useCallback(
    (key: string, down: boolean, shift: boolean, mod: boolean): boolean => {
      if (key === " ") {
        setSpaceDown(down);
        return true;
      }
      if (!down) return false;
      const step = shift ? ARROW_STEP * 4 : ARROW_STEP;
      const pan = (dx: number, dy: number) => setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      switch (key) {
        case "=":
        case "+":
          setView((v) => zoomAt(v, stepZoom(v.zoom, 1), center()));
          return true;
        case "-":
          setView((v) => zoomAt(v, stepZoom(v.zoom, -1), center()));
          return true;
        case "0":
          if (mod || !shift) setView((v) => zoomAt(v, 1, center()));
          return true;
        case "!":
        case "1":
          if (!shift) return false;
          fit();
          return true;
        case "ArrowLeft": pan(step, 0); return true;
        case "ArrowRight": pan(-step, 0); return true;
        case "ArrowUp": pan(0, step); return true;
        case "ArrowDown": pan(0, -step); return true;
      }
      return false;
    },
    [fit],
  );
  const onFrameKey = useCallback((m: KeyMessage) => void onKey(m.key, m.down, m.shift, m.mod), [onKey]);

  useEffect(() => {
    if (!active) return;
    const handle = (e: KeyboardEvent, down: boolean) => {
      if (typing(e.target) || (e.target instanceof HTMLButtonElement && e.key === " ")) return;
      if (onKey(e.key, down, e.shiftKey, e.ctrlKey || e.metaKey)) e.preventDefault();
    };
    const keydown = (e: KeyboardEvent) => handle(e, true);
    const keyup = (e: KeyboardEvent) => handle(e, false);
    const blur = () => setSpaceDown(false);
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
    };
  }, [active !== null, onKey]);

  // Drag on the empty canvas, with the middle button, or with Space held: pan.
  const onPointerDown = (e: React.PointerEvent) => {
    const onBackground = e.target === e.currentTarget || (e.target as Element).classList.contains("canvas-world");
    if (!(onBackground || e.button === 1 || spaceDown)) return;
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setMenuOpen(false);
    setDrag({ kind: "pan", start: { x: e.clientX, y: e.clientY }, view });
  };
  const onMoveStart = useCallback((e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    const frame = state.current.frames?.find((f) => f.id === id);
    if (!frame) return;
    e.preventDefault();
    e.stopPropagation();
    ref.current?.setPointerCapture(e.pointerId);
    setDrag({ kind: "move", id, start: { x: e.clientX, y: e.clientY }, frame, moved: false });
  }, []);
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.start.x;
    const dy = e.clientY - drag.start.y;
    if (drag.kind === "pan") setView({ ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy });
    else {
      const x = Math.round(drag.frame.x + dx / view.zoom);
      const y = Math.round(drag.frame.y + dy / view.zoom);
      setFrames((list) => list?.map((f) => (f.id === drag.id ? { ...f, x, y } : f)) ?? list);
      if (!drag.moved && (dx || dy)) setDrag({ ...drag, moved: true });
    }
  };
  const onPointerUp = () => {
    if (drag?.kind === "move" && drag.moved && frames) changeFrames(frames);
    setDrag(null);
  };

  const addFrame = (label: string, width: number, height: number) => {
    if (!frames || frames.length >= FRAME_LIMITS.count) return;
    const at = nextPosition(frames);
    changeFrames([...frames, { id: newFrameId(frames, label), label, width, height, ...at }]);
    setMenuOpen(false);
  };
  const removeFrame = useCallback((id: string) => {
    const f = state.current.frames;
    if (f && f.length > 1) changeFrames(f.filter((x) => x.id !== id));
  }, [changeFrames]);

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
  const panning = drag?.kind === "pan" || spaceDown;
  return (
    <main
      ref={ref}
      className={`canvas${drag ? " is-dragging" : ""}${panning ? " is-panning" : ""}`}
      aria-label="Canvas"
      style={{
        backgroundPosition: `${view.x}px ${view.y}px`,
        backgroundSize: `calc(var(--canvas-grid) * ${view.zoom}) calc(var(--canvas-grid) * ${view.zoom})`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="canvas-world"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, "--zoom": view.zoom } as React.CSSProperties}
      >
        {frames?.map((f) => (
          <Frame
            key={f.id}
            frame={f}
            src={src}
            zoom={view.zoom}
            selection={selection}
            pins={pins}
            canRemove={frames.length > 1}
            onSelect={onSelect}
            onClear={onClear}
            onPin={onPin}
            onRemove={removeFrame}
            onMoveStart={onMoveStart}
            onWheel={onFrameWheel}
            onKey={onFrameKey}
          />
        ))}
      </div>

      {layoutError && (
        <p className="canvas-error notice notice-danger" role="alert">
          <Icon name="alert" />
          <span>{layoutError}</span>
        </p>
      )}

      {menuOpen && <AddFrameMenu onAdd={addFrame} onClose={() => setMenuOpen(false)} />}

      <div className="canvas-toolbar" role="toolbar" aria-label="Canvas">
        <button
          className="icon-btn"
          onClick={() => setMenuOpen((o) => !o)}
          aria-label="Add frame"
          aria-expanded={menuOpen}
          title="Add frame"
          disabled={!frames || frames.length >= FRAME_LIMITS.count}
        >
          <Icon name="frame" />
        </button>
        <button
          className="icon-btn"
          onClick={() => frames && changeFrames(arrangeRow(frames))}
          aria-label="Arrange frames in a row"
          title="Arrange frames in a row"
          disabled={!frames?.length}
        >
          <Icon name="arrange" />
        </button>
        <span className="toolbar-sep" />
        <button className="icon-btn" onClick={() => zoomTo(stepZoom(view.zoom, -1))} aria-label="Zoom out" title="Zoom out (−)" disabled={view.zoom <= ZOOM_MIN}>
          <Icon name="minus" />
        </button>
        <button className="zoom-value" onClick={() => zoomTo(1)} title="Zoom to 100% (0)" aria-label={`Zoom ${Math.round(view.zoom * 100)}%. Set to 100%`}>
          {Math.round(view.zoom * 100)}%
        </button>
        <button className="icon-btn" onClick={() => zoomTo(stepZoom(view.zoom, 1))} aria-label="Zoom in" title="Zoom in (+)" disabled={view.zoom >= ZOOM_MAX}>
          <Icon name="plus" />
        </button>
        <span className="toolbar-sep" />
        <button className="icon-btn" onClick={fit} aria-label="Fit to screen" title="Fit to screen (Shift+1)">
          <Icon name="fit" />
        </button>
      </div>
    </main>
  );
}
