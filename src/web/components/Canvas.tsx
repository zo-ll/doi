import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { designUrl, getJSON, sendJSON, variantPageUrl, versionPageUrl, type Active, type VariantSetView, type VersionView } from "../api.ts";
import { formatTokens } from "../chat.ts";
import type { Pin } from "../comments.ts";
import { parseFrameMessage, trackMessage, type FrameMessage, type Layout, type Rect } from "../frame.ts";
import { alignStyle, DEFAULT_SCALE, dropTarget, nudgeStyle, resizeStyle, sameSpot, type Axis, type Drop, type ElementStyle, type Handle, type Place, type SpacingScale } from "../edit.ts";
import { arrangeRow, fitView, newFrameId, nextPosition, stepZoom, wheelFactor, zoomAt, ZOOM_MAX, ZOOM_MIN, type Point, type View } from "../viewport.ts";
import { FRAME_LIMITS, PRESETS, type Frame as FrameSpec } from "../../workspace/frames.ts";
import { CHANGED_AFTER } from "../../workspace/edit-messages.ts";
import type { Selection } from "./ChatPanel.tsx";

type FrameState = "loading" | "ready" | "error";
type WheelMessage = Extract<FrameMessage, { type: "doi:wheel" }>;
type KeyMessage = Extract<FrameMessage, { type: "doi:key" }>;
/** Select (V) picks elements, Comment (C) starts a comment on one, Hand (H) pans everywhere. */
export type Tool = "select" | "comment" | "hand";

/** Screen pixels above a box for its tag. With less room, the tag goes inside the box. */
const TAG_ROOM = 24;
/**
 * Screen pixels of the align bar under a box, and its width. They follow tokens.css: --edit-btn
 * (20) plus the --space-2 gap and the border, and six buttons of --edit-btn. Change them together.
 */
const BAR_ROOM = 32;
const BAR_WIDTH = 124;
/** Screen pixels that one arrow key pans; with Shift, four times as many. */
const ARROW_STEP = 64;
const boxStyle = (r: Rect) => ({ left: r.x, top: r.y, width: r.width, height: r.height });
const layoutUrl = (a: Active) => `/api/projects/${a.project}/designs/${a.design}/layout`;
const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: "select", label: "Select", key: "V" },
  { id: "comment", label: "Comment", key: "C" },
  { id: "hand", label: "Hand", key: "H" },
];

const NO_VARS: Record<string, string> = {};

/** A resize handle, a drag among the siblings, or a nudge of the margins (Alt + drag). */
type EditMode = Handle | "reorder" | "nudge";
/** What a frame knows when a canvas edit starts (#66). */
export interface EditStart {
  frameId: string;
  oid: string;
  mode: EditMode;
  /** The element's box and layout when the drag started, in the frame's viewport. */
  rect: Rect;
  layout: Layout;
  /** The pointer in the frame's viewport. */
  at: Point;
  /** Sends a message to this frame's page. */
  post: (message: object) => void;
}
type EditBody = { oid: string; style: ElementStyle } | { oid: string; move: { target: string; position: Drop["position"]; page: string } };
/** Screen pixels a drag must move before it counts. */
const DRAG_SLOP = 3;
const ALIGN: { axis: Axis; place: Place; label: string; icon: string }[] = [
  { axis: "x", place: "start", label: "Align left", icon: "⇤" },
  { axis: "x", place: "center", label: "Align center", icon: "↔" },
  { axis: "x", place: "end", label: "Align right", icon: "⇥" },
  { axis: "y", place: "start", label: "Align top", icon: "⤒" },
  { axis: "y", place: "center", label: "Align middle", icon: "↕" },
  { axis: "y", place: "end", label: "Align bottom", icon: "⤓" },
];

/** True while the user types in a field of the app: canvas keys do nothing then. */
const typing = (t: EventTarget | null) => t instanceof Element && t.closest("input, textarea, select, [contenteditable]") !== null;

const Frame = memo(function Frame({
  frame,
  src,
  page,
  zoom,
  selection,
  pins,
  canRemove,
  readOnly,
  onSelect,
  onClear,
  onPin,
  onRemove,
  onMoveStart,
  onWheel,
  onKey,
  onOpenHistory,
  liveVars,
  editable,
  deepest,
  dropLine,
  onEditStart,
  onAlign,
}: {
  frame: FrameSpec;
  src: string;
  page: string;
  zoom: number;
  selection: Selection | null;
  pins: Pin[];
  canRemove: boolean;
  /** An old version: no selection, pins or frame changes. */
  readOnly: boolean;
  onSelect: (s: Selection) => void;
  onClear: () => void;
  onPin: (oid: string) => void;
  onRemove: (id: string) => void;
  onMoveStart: (e: React.PointerEvent, id: string) => void;
  onWheel: (frame: FrameSpec, m: WheelMessage) => void;
  onKey: (m: KeyMessage) => void;
  onOpenHistory?: () => void;
  /** CSS variables set on the page for a live tweak. */
  liveVars: Record<string, string>;
  /** The selected element shows handles: resize, drag among the siblings, align. */
  editable: boolean;
  /** A click picks the deepest element under the pointer (Comment tool), not one level per click. */
  deepest: boolean;
  /** The insert line of a drag among the siblings, in this frame. */
  dropLine: Rect | null;
  onEditStart: (e: React.PointerEvent, edit: EditStart) => void;
  onAlign: (oid: string, style: ElementStyle, post: (message: object) => void) => void;
}) {
  const { width, height, label } = frame;
  const ref = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<FrameState>("loading");
  const [reload, setReload] = useState(0);
  const [rects, setRects] = useState<{
    selected: Rect | null;
    layout: Layout | null;
    hover: { oid: string; rect: Rect } | null;
    pins: Record<string, Rect>;
  }>({ selected: null, layout: null, hover: null, pins: {} });
  const oid = readOnly ? null : (selection?.oid ?? null);
  const shownPins = readOnly ? [] : pins;
  // One string, so the effect below runs only when the set of pinned elements changes.
  const pinKey = shownPins.map((p) => p.oid).join(" ");
  const track = useRef(trackMessage(null));
  track.current = trackMessage(oid, pinKey ? pinKey.split(" ") : [], deepest);
  // The latest frame and handlers, so the message listener stays the same while the frame moves.
  const latest = useRef({ frame, readOnly, onSelect, onClear, onWheel, onKey });
  latest.current = { frame, readOnly, onSelect, onClear, onWheel, onKey };
  const url = reload ? `${src}${src.includes("?") ? "&" : "?"}reload=${reload}` : src;

  // An iframe cannot report an HTTP error, so check the page before showing it.
  useEffect(() => {
    let live = true;
    setState("loading");
    fetch(url, { method: "HEAD" })
      .then((r) => live && !r.ok && setState("error"))
      .catch(() => live && setState("error"));
    return () => {
      live = false;
    };
  }, [url]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== ref.current?.contentWindow) return;
      const m = parseFrameMessage(event.data);
      const h = latest.current;
      if (m?.type === "doi:select") !h.readOnly && h.onSelect({ oid: m.oid });
      else if (m?.type === "doi:clear") !h.readOnly && h.onClear();
      else if (m?.type === "doi:rects") setRects({ selected: m.selected, layout: m.layout, hover: h.readOnly ? null : m.hover, pins: m.pins });
      else if (m?.type === "doi:wheel") h.onWheel(h.frame, m);
      else if (m?.type === "doi:key") h.onKey(m);
      // A page that loaded again asks which element is selected, which have pins, and the live tweaks.
      else if (m?.type === "doi:ready") {
        ref.current?.contentWindow?.postMessage(track.current, "*");
        if (Object.keys(sentVars.current).length) ref.current?.contentWindow?.postMessage({ type: "doi:vars", vars: sentVars.current }, "*");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Every frame of the design shows the selection and the pins, in its own layout.
  useEffect(() => {
    if (!oid) setRects((r) => ({ ...r, selected: null, layout: null }));
    ref.current?.contentWindow?.postMessage(track.current, "*");
  }, [oid, pinKey, deepest]);

  // Live tweaks: send the changed values, and null for the ones that are gone.
  const sentVars = useRef<Record<string, string>>({});
  useEffect(() => {
    const before = sentVars.current;
    const vars: Record<string, string | null> = { ...liveVars };
    for (const name of Object.keys(before)) if (!(name in liveVars)) vars[name] = null;
    sentVars.current = liveVars;
    if (Object.keys(vars).length) ref.current?.contentWindow?.postMessage({ type: "doi:vars", vars }, "*");
  }, [liveVars]);

  // A new page has no rects until its bridge reports them.
  useEffect(() => setRects({ selected: null, layout: null, hover: null, pins: {} }), [url]);

  const post = useCallback((message: object) => ref.current?.contentWindow?.postMessage(message, "*"), []);
  const canEdit = editable && !readOnly && oid !== null && rects.selected !== null && rects.layout !== null;
  const startEdit = (e: React.PointerEvent, mode: EditMode) => {
    const box = ref.current?.getBoundingClientRect();
    if (e.button !== 0 || !box || !oid || !rects.selected || !rects.layout) return;
    e.preventDefault();
    e.stopPropagation();
    const at = { x: (e.clientX - box.left) / zoom, y: (e.clientY - box.top) / zoom };
    onEditStart(e, { frameId: frame.id, oid, mode: mode === "reorder" && e.altKey ? "nudge" : mode, rect: rects.selected, layout: rects.layout, at, post });
  };

  return (
    <figure className="frame" style={{ left: frame.x, top: frame.y, width, height }}>
      <figcaption
        className="frame-label"
        style={{ transform: `scale(${1 / zoom})` }}
        onPointerDown={(e) => !readOnly && onMoveStart(e, frame.id)}
        title={readOnly ? undefined : "Drag to move"}
      >
        <span className="frame-name">{label}</span>
        <span className="frame-size">
          {width} × {height}
        </span>
        {canRemove && !readOnly && (
          <button
            className="frame-remove"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onRemove(frame.id)}
            aria-label={`Remove frame ${label}`}
            title="Remove frame"
          >
            ×
          </button>
        )}
      </figcaption>
      <div className="frame-surface">
        {state === "error" ? (
          <div className="frame-state">
            <div className="frame-error" role="alert" style={{ transform: `scale(${1 / zoom})` }}>
              <p className="frame-error-title">
                <span className="dot dot-err" />
                This page could not load
              </p>
              <p className="frame-error-text">
                <span className="mono">{page}</span> is missing, or the server did not answer.
              </p>
              <div className="frame-error-actions">
                <button className="btn btn-secondary btn-md" onClick={() => setReload((n) => n + 1)}>
                  Reload frame
                </button>
                {onOpenHistory && (
                  <button className="btn btn-ghost btn-md" onClick={onOpenHistory}>
                    Open history
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <>
            <iframe
              ref={ref}
              src={url}
              title={`${label} preview`}
              sandbox="allow-scripts"
              width={width}
              height={height}
              onLoad={() => setState((s) => (s === "error" ? s : "ready"))}
            />
            <div className="frame-overlay">
              {shownPins.map((p) => {
                // Own keys only: the first state is a plain object, and an id may be "__proto__".
                const r = Object.hasOwn(rects.pins, p.oid) ? rects.pins[p.oid] : null;
                if (!r) return null;
                const numbers = p.numbers.join(", ");
                return (
                  <button
                    key={p.oid}
                    className="pin"
                    style={{ left: r.x + r.width, top: r.y, transform: `translate(-50%, -50%) scale(${1 / zoom})` }}
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
                  className={[
                    "selection-box",
                    rects.selected.y < TAG_ROOM / zoom ? "tag-inside" : "",
                    // No room under the box or on its right in the frame: the bar goes inside, or to the right edge.
                    rects.selected.y + rects.selected.height + BAR_ROOM / zoom > height ? "bar-inside" : "",
                    rects.selected.x + BAR_WIDTH / zoom > width ? "bar-end" : "",
                  ].filter(Boolean).join(" ")}
                  style={boxStyle(rects.selected)}
                >
                  <span
                    className={`selection-tag${canEdit ? " is-grip" : ""}`}
                    onPointerDown={canEdit ? (e) => startEdit(e, "reorder") : undefined}
                    title={canEdit ? "Drag to move it among its siblings. Alt + drag changes its margins." : undefined}
                  >
                    {oid}
                  </span>
                  {canEdit && (
                    <>
                      {(["e", "s", "se"] as const).map((h) => (
                        <span key={h} className={`resize-handle resize-${h}`} onPointerDown={(e) => startEdit(e, h)} title={h === "e" ? "Width" : h === "s" ? "Height" : "Width and height"} />
                      ))}
                      <span className="edit-bar" role="toolbar" aria-label={`Align ${oid}`}>
                        {ALIGN.map((a) => {
                          const style = alignStyle(rects.layout!, a.axis, a.place);
                          return (
                            <button key={a.label} className="edit-btn" disabled={!style} aria-label={a.label} title={a.label} onClick={() => style && onAlign(oid, style, post)}>
                              {a.icon}
                            </button>
                          );
                        })}
                      </span>
                    </>
                  )}
                </div>
              )}
              {dropLine && <div className="drop-line" style={boxStyle(dropLine)} />}
            </div>
          </>
        )}
        {state === "loading" && (
          <div className="frame-loading" aria-label={`Loading ${page}`}>
            <div className="skeleton" style={{ width: "30%", height: "4%" }} />
            <div className="skeleton" style={{ height: "28%" }} />
            <div className="skeleton" style={{ height: "40%" }} />
            <span className="frame-loading-chip" style={{ transform: `translate(-50%, -50%) scale(${1 / zoom})` }}>
              <span className="spinner" />
              Loading {page}
            </span>
          </div>
        )}
      </div>
    </figure>
  );
});

/** One variant in the grid: the page at the size of the first frame, its text and Pick. */
const VariantCard = memo(function VariantCard({
  active,
  setId,
  v,
  frame,
  scale,
  canPick,
  onPick,
}: {
  active: Active;
  setId: string;
  v: VariantSetView["variants"][number];
  frame: FrameSpec;
  scale: number;
  canPick: boolean;
  onPick: (n: number) => void;
}) {
  const u = v.usage;
  const state =
    v.status === "running"
      ? { tone: "dot-accent", label: "Working…", pulse: true }
      : v.status === "done"
        ? { tone: "dot-ok", label: "Done", pulse: false }
        : v.status === "stopped"
          ? { tone: "", label: "Stopped", pulse: false }
          : { tone: "dot-err", label: "Failed", pulse: false };
  return (
    <article className={`vcard${v.status === "error" ? " is-failed" : ""}`} aria-label={`Variant ${v.n}`}>
      <header className="vcard-head">
        <span className="vcard-n">{v.n}</span>
        <span className="vcard-model truncate" title={`${v.provider}:${v.model}`}>
          {v.model}
        </span>
        <span className="spacer" />
        <span className="status">
          <span className={`dot ${state.tone}${state.pulse ? " is-pulsing" : ""}`} />
          {state.label}
        </span>
      </header>
      <div className="vcard-view" style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
        {v.status === "error" ? (
          <p className="vcard-error">{v.error ?? "This variant failed."}</p>
        ) : v.status === "running" ? (
          <div className="vcard-skeleton">
            <div className="skeleton" style={{ height: "8%", width: "28%" }} />
            <div className="skeleton" style={{ height: "34%", width: "55%" }} />
            <div className="skeleton" style={{ height: "30%" }} />
          </div>
        ) : (
          <iframe
            src={`${variantPageUrl(active.project, active.design, setId, v.n)}?s=${v.status}`}
            title={`Variant ${v.n} preview`}
            sandbox="allow-scripts"
            width={frame.width}
            height={frame.height}
            style={{ transform: `scale(${scale})` }}
          />
        )}
      </div>
      <div className="vcard-body">
        <p className="vcard-text">{v.text || (v.status === "running" ? "The model is working on this variant." : "")}</p>
        {u.inputTokens + u.outputTokens > 0 && (
          <p className="vcard-tokens" title="Input and output tokens">
            in {formatTokens(u.inputTokens)} · out {formatTokens(u.outputTokens)}
          </p>
        )}
        {v.status === "done" && (
          <div>
            <button className="btn btn-primary" disabled={!canPick} onClick={() => onPick(v.n)}>
              Pick {v.n}
            </button>
          </div>
        )}
      </div>
    </article>
  );
});

/** Variants replace the canvas in place, side by side at the size of the first frame. */
function VariantsView({
  active,
  set,
  frame,
  error,
  onPick,
  onDiscard,
}: {
  active: Active;
  set: VariantSetView;
  frame: FrameSpec;
  error: string | null;
  onPick: (n: number) => void;
  onDiscard: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [cardWidth, setCardWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current?.querySelector(".vcard-view");
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setCardWidth(entry!.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [set.id]);
  const done = set.variants.filter((v) => v.status === "done").length;
  return (
    <div className="variants-view" ref={ref} role="region" aria-label="Variants">
      <div className="variants-head">
        <span className="variants-title">Variants</span>
        <span className="variants-meta">
          {done} of {set.variants.length} done · {frame.label} {frame.width} × {frame.height}
        </span>
        <span className="variants-prompt truncate">“{set.prompt}”</span>
        <span className="variants-hint">New turns wait until you pick one or discard all.</span>
        <button className="btn btn-danger-outline" disabled={set.running} onClick={onDiscard} title={set.running ? "Wait until the variants stop" : undefined}>
          Discard all
        </button>
      </div>
      {error && (
        <div className="banner banner-err" role="alert">
          <span className="dot dot-err" />
          {error}
        </div>
      )}
      <div className="variants-grid" style={{ gridTemplateColumns: `repeat(${set.variants.length}, minmax(0, 1fr))` }}>
        {set.variants.map((v) => (
          <VariantCard
            key={`${set.id}-${v.n}`}
            active={active}
            setId={set.id}
            v={v}
            frame={frame}
            scale={cardWidth ? cardWidth / frame.width : 0}
            canPick={!set.running}
            onPick={onPick}
          />
        ))}
      </div>
    </div>
  );
}

/** The "+ Frame" menu: the presets, or a custom size. */
function AddFrameMenu({ onAdd, onClose }: { onAdd: (label: string, width: number, height: number) => void; onClose: () => void }) {
  const [w, setW] = useState("1280");
  const [h, setH] = useState("800");
  const width = Number(w);
  const height = Number(h);
  const validW = Number.isInteger(width) && width >= FRAME_LIMITS.min && width <= FRAME_LIMITS.maxWidth;
  const validH = Number.isInteger(height) && height >= FRAME_LIMITS.min && height <= FRAME_LIMITS.maxHeight;
  const hint = !validW
    ? `Width ${FRAME_LIMITS.min}–${FRAME_LIMITS.maxWidth}.`
    : !validH
      ? `Height ${FRAME_LIMITS.min}–${FRAME_LIMITS.maxHeight}.`
      : `${FRAME_LIMITS.min}–${FRAME_LIMITS.maxWidth} × ${FRAME_LIMITS.min}–${FRAME_LIMITS.maxHeight} px.`;
  return (
    <div className="menu add-frame-menu" role="dialog" aria-label="Add frame" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="menu-label">Presets</div>
      {PRESETS.map((p) => (
        <button key={p.label} className="menu-item" onClick={() => onAdd(p.label, p.width, p.height)}>
          {p.label}
          <span className="meta">
            {p.width} × {p.height}
          </span>
        </button>
      ))}
      <div className="menu-sep" />
      <div className="menu-label">Custom</div>
      <form
        className="custom-size"
        onSubmit={(e) => {
          e.preventDefault();
          if (validW && validH) onAdd(`${width} × ${height}`, width, height);
        }}
      >
        <input className="input mono" aria-label="Custom width" aria-invalid={!validW} inputMode="numeric" value={w} onChange={(e) => setW(e.target.value)} />
        <span className="muted">×</span>
        <input className="input mono" aria-label="Custom height" aria-invalid={!validH} inputMode="numeric" value={h} onChange={(e) => setH(e.target.value)} />
        <button className="btn btn-primary btn-sm" disabled={!validW || !validH}>
          Add
        </button>
      </form>
      <p className={`custom-size-hint${validW && validH ? "" : " is-error"}`}>{hint}</p>
    </div>
  );
}

type Drag =
  | { kind: "pan"; start: Point; view: View }
  | { kind: "move"; id: string; start: Point; frame: FrameSpec; moved: boolean }
  | { kind: "edit"; edit: EditStart; start: Point; style: ElementStyle | null; drop: Drop | null };

export function Canvas({
  active,
  page,
  revision,
  selection,
  pins,
  onSelect,
  onClear,
  onPin,
  onComment,
  onOpenHistory,
  variants = null,
  variantsError = null,
  onPickVariant,
  onDiscardVariants,
  preview = null,
  previewLabel = "",
  previewBusy = false,
  previewError = null,
  onRestorePreview,
  onClosePreview,
  overlay,
  liveVars = NO_VARS,
  onEditSaving,
}: {
  active: Active | null;
  /** The page of the design that the frames show. */
  page: string;
  /** Changes when the design files changed; the frames load again. */
  revision: number;
  selection: Selection | null;
  /** Elements with open comments. */
  pins: Pin[];
  onSelect: (s: Selection) => void;
  onClear: () => void;
  onPin: (oid: string) => void;
  /** The Comment tool picked an element: start a comment on it. */
  onComment: (oid: string) => void;
  onOpenHistory?: () => void;
  /** The open variant set of the design: it replaces the frames until a pick or a discard. */
  variants?: VariantSetView | null;
  variantsError?: string | null;
  onPickVariant?: (n: number) => void;
  onDiscardVariants?: () => void;
  /** An old version from the History tab: the frames show it, read-only. */
  preview?: VersionView | null;
  /** "v11 · 2 Oct 10:12" */
  previewLabel?: string;
  previewBusy?: boolean;
  previewError?: string | null;
  onRestorePreview?: () => void;
  onClosePreview?: () => void;
  /** Floating panels over the canvas (Tweaks). */
  overlay?: React.ReactNode;
  /** CSS variables of a live tweak, set on every page. */
  liveVars?: Record<string, string>;
  /** A canvas edit goes to the server: the next design change keeps the selection. */
  onEditSaving?: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [frames, setFrames] = useState<FrameSpec[] | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 0.4 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const needsFit = useRef(true);
  const state = useRef({ view, frames, active, tool, page });
  state.current = { view, frames, active, tool, page };
  const [scale, setScale] = useState<SpacingScale>(DEFAULT_SCALE);
  const [editError, setEditError] = useState<string | null>(null);
  /** Changes when a failed edit must take its preview off the pages. */
  const [editReload, setEditReload] = useState(0);
  /** The commits of this session's canvas edits on the open design, newest last, for ⌘Z. */
  const undoStack = useRef<string[]>([]);
  /** Edits and undos go to the server one after the other, so they do not lock each other out. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback((run: () => Promise<unknown>) => {
    queue.current = queue.current.then(run, run);
  }, []);

  useEffect(() => {
    undoStack.current = [];
    setEditError(null);
  }, [active?.project, active?.design]);

  // The spacing scale that resizes and nudges snap to; styles.css can change it.
  useEffect(() => {
    if (!active) return;
    let live = true;
    getJSON<SpacingScale>(`/api/projects/${active.project}/designs/${active.design}/spacing`)
      .then((s) => live && setScale(s))
      .catch(() => live && setScale(DEFAULT_SCALE));
    return () => {
      live = false;
    };
  }, [active?.project, active?.design, revision]);

  /** Saves one canvas edit as a version. A failure takes the preview away and says why. */
  const saveEdit = useCallback(
    (body: EditBody) => {
      const a = state.current.active;
      if (!a) return;
      onEditSaving?.();
      enqueue(() =>
        sendJSON<{ commit: string | null; commitError?: string }>("POST", `/api/projects/${a.project}/designs/${a.design}/edit`, body)
          .then((r) => {
            if (r.commit) undoStack.current.push(r.commit);
            setEditError(r.commitError ? `The edit is saved, but not in the history: ${r.commitError}` : null);
          })
          .catch((e) => {
            setEditError(`The edit was not saved: ${(e as Error).message}`);
            setEditReload((n) => n + 1);
          }),
      );
    },
    [onEditSaving, enqueue],
  );

  /** ⌘Z: the newest canvas edit of this session goes back, as a new version. */
  const undoEdit = useCallback(() => {
    const a = state.current.active;
    if (!a || !undoStack.current.length) return false;
    onEditSaving?.();
    // The edit to undo is taken when the request starts, so an edit still in the queue comes first.
    enqueue(async () => {
      const commit = undoStack.current.pop();
      if (!commit) return;
      await sendJSON<{ commit: string | null; commitError?: string }>("POST", `/api/projects/${a.project}/designs/${a.design}/edit/undo`, { commit })
        .then((r) => setEditError(r.commitError ? `The undo is saved, but not in the history: ${r.commitError}` : null))
        .catch((e) => {
          const message = (e as Error).message;
          // A later change (a turn, a tweak) makes the older edits stay; else the edit can be undone again.
          if (message.startsWith(CHANGED_AFTER)) undoStack.current = [];
          else undoStack.current.push(commit);
          setEditError(`The edit was not undone: ${message}`);
        });
    });
    return true;
  }, [onEditSaving, enqueue]);

  const onEditStart = useCallback((e: React.PointerEvent, edit: EditStart) => {
    if (state.current.tool !== "select") return;
    ref.current?.setPointerCapture(e.pointerId);
    setMenuOpen(false);
    setDrag({ kind: "edit", edit, start: { x: e.clientX, y: e.clientY }, style: null, drop: null });
  }, []);

  const onAlign = useCallback(
    (oid: string, style: ElementStyle, post: (message: object) => void) => {
      post({ type: "doi:style", oid, style });
      saveEdit({ oid, style });
    },
    [saveEdit],
  );

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
    return () => {
      live = false;
    };
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
      // The variants grid scrolls like a page.
      if ((e.target as Element).closest(".variants-view")) return;
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
      if (mod && !shift && key.toLowerCase() === "z") return undoEdit();
      const step = shift ? ARROW_STEP * 4 : ARROW_STEP;
      const pan = (dx: number, dy: number) => setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      if (!mod && !shift) {
        const t = TOOLS.find((x) => x.key.toLowerCase() === key.toLowerCase());
        if (t) {
          setTool(t.id);
          return true;
        }
        if (key.toLowerCase() === "f") {
          setMenuOpen((o) => !o);
          return true;
        }
      }
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
        case "Escape":
          setMenuOpen(false);
          return false;
        case "ArrowLeft":
          pan(step, 0);
          return true;
        case "ArrowRight":
          pan(-step, 0);
          return true;
        case "ArrowUp":
          pan(0, step);
          return true;
        case "ArrowDown":
          pan(0, -step);
          return true;
      }
      return false;
    },
    [fit, undoEdit],
  );
  // A key the canvas does not use goes to the app's shortcuts, as if the app had the focus.
  const onFrameKey = useCallback(
    (m: KeyMessage) => {
      if (onKey(m.key, m.down, m.shift, m.mod) || !m.down) return;
      window.dispatchEvent(new KeyboardEvent("keydown", { key: m.key, shiftKey: m.shift, ctrlKey: m.mod }));
    },
    [onKey],
  );

  useEffect(() => {
    if (!active) return;
    const handle = (e: KeyboardEvent, down: boolean) => {
      if (typeof e.key !== "string") return; // a datalist or autofill pick
      if (typing(e.target) || (e.target instanceof HTMLButtonElement && e.key === " ")) return;
      // A dialog over the canvas has the keys.
      if (document.querySelector('[aria-modal="true"]')) return;
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

  // The Comment tool turns a pick into the start of a comment.
  const select = useCallback(
    (s: Selection) => {
      onSelect(s);
      if (state.current.tool === "comment") onComment(s.oid);
    },
    [onSelect, onComment],
  );

  // Drag on the empty canvas, with the middle button, with Space held or with the Hand tool: pan.
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest(".canvas-toolbar, .menu, .preview-banner, .canvas-overlay")) return;
    const onBackground = e.target === e.currentTarget || (e.target as Element).classList.contains("canvas-world");
    if (!(onBackground || e.button === 1 || spaceDown || tool === "hand")) return;
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setMenuOpen(false);
    setDrag({ kind: "pan", start: { x: e.clientX, y: e.clientY }, view });
  };
  const onMoveStart = useCallback((e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || state.current.tool === "hand") return;
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
    else if (drag.kind === "edit") {
      if (Math.hypot(dx, dy) < DRAG_SLOP && !drag.style && !drag.drop) return;
      const { edit } = drag;
      const fx = dx / view.zoom;
      const fy = dy / view.zoom;
      if (edit.mode === "reorder") {
        let drop = dropTarget(edit.layout, { x: edit.at.x + fx, y: edit.at.y + fy });
        if (drop && sameSpot(edit.layout, drop)) drop = null;
        setDrag({ ...drag, drop });
        return;
      }
      const style = edit.mode === "nudge" ? nudgeStyle(edit.layout.margins, fx, fy, scale) : resizeStyle(edit.mode, edit.rect, edit.layout.extra, fx, fy, scale.unit);
      edit.post({ type: "doi:style", oid: edit.oid, style });
      setDrag({ ...drag, style });
    } else {
      const x = Math.round(drag.frame.x + dx / view.zoom);
      const y = Math.round(drag.frame.y + dy / view.zoom);
      setFrames((list) => list?.map((f) => (f.id === drag.id ? { ...f, x, y } : f)) ?? list);
      if (!drag.moved && (dx || dy)) setDrag({ ...drag, moved: true });
    }
  };
  const onPointerUp = () => {
    if (drag?.kind === "move" && drag.moved && frames) changeFrames(frames);
    if (drag?.kind === "edit") {
      const { edit, drop, style } = drag;
      if (drop) {
        edit.post({ type: "doi:move", oid: edit.oid, target: drop.target, position: drop.position });
        saveEdit({ oid: edit.oid, move: { target: drop.target, position: drop.position, page: state.current.page } });
      } else if (style && Object.keys(style).length) saveEdit({ oid: edit.oid, style });
    }
    setDrag(null);
  };

  const addFrame = (label: string, width: number, height: number) => {
    if (!frames || frames.length >= FRAME_LIMITS.count) return;
    const at = nextPosition(frames);
    changeFrames([...frames, { id: newFrameId(frames, label), label, width, height, ...at }]);
    setMenuOpen(false);
  };
  const removeFrame = useCallback(
    (id: string) => {
      const f = state.current.frames;
      if (f && f.length > 1) changeFrames(f.filter((x) => x.id !== id));
    },
    [changeFrames],
  );

  if (!active) {
    return (
      <main className="canvas canvas-empty">
        <div className="canvas-empty-text">
          <h2>No design open</h2>
          <p>Open the projects with the doi menu or {navigator.platform.includes("Mac") ? "⌘P" : "Ctrl+P"}.</p>
        </div>
      </main>
    );
  }

  const pagePath = page === "index.html" ? "" : page;
  const src = preview
    ? `${versionPageUrl(active.project, active.design, preview.sha)}${pagePath}`
    : `${designUrl(active.project, active.design)}${pagePath}?v=${revision}${editReload ? `.${editReload}` : ""}`;
  const panning = drag?.kind === "pan" || spaceDown;
  const showVariants = variants !== null && !!frames?.length;
  return (
    <main
      ref={ref}
      className={`canvas tool-${tool}${drag ? " is-dragging" : ""}${panning ? " is-panning" : ""}`}
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
      {showVariants ? (
        <VariantsView
          active={active}
          set={variants}
          frame={frames![0]!}
          error={variantsError}
          onPick={(n) => onPickVariant?.(n)}
          onDiscard={() => onDiscardVariants?.()}
        />
      ) : (
        <div className="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, "--zoom": view.zoom } as React.CSSProperties}>
          {frames?.map((f) => (
            <Frame
              key={f.id}
              frame={f}
              src={src}
              page={page}
              zoom={view.zoom}
              selection={selection}
              pins={pins}
              canRemove={frames.length > 1}
              readOnly={preview !== null}
              onSelect={select}
              onClear={onClear}
              onPin={onPin}
              onRemove={removeFrame}
              onMoveStart={onMoveStart}
              onWheel={onFrameWheel}
              onKey={onFrameKey}
              onOpenHistory={onOpenHistory}
              liveVars={preview ? NO_VARS : liveVars}
              editable={tool === "select" && preview === null}
              deepest={tool === "comment"}
              dropLine={drag?.kind === "edit" && drag.edit.frameId === f.id ? (drag.drop?.line ?? null) : null}
              onEditStart={onEditStart}
              onAlign={onAlign}
            />
          ))}
        </div>
      )}

      {preview && !showVariants && (
        <>
          <div className="preview-edge" aria-hidden="true" />
          <div className="preview-banner" role="status">
            <span className="dot dot-warn" />
            <strong>Preview of {previewLabel}</strong>
            <span className="muted truncate">{preview.message} · read-only</span>
            <button className="btn btn-primary btn-md" disabled={previewBusy || variants !== null} onClick={onRestorePreview}>
              Restore this version
            </button>
            <button className="btn btn-secondary btn-md" onClick={onClosePreview} title="Close preview (Esc)">
              Close
            </button>
            {previewError && (
              <span className="field-error" role="alert">
                {previewError}
              </span>
            )}
          </div>
        </>
      )}

      {(layoutError || editError) && (
        <div className="banner banner-err canvas-error" role="alert">
          <span className="dot dot-err" />
          {layoutError ?? editError}
          {!layoutError && (
            <button className="btn btn-ghost btn-sm" onClick={() => setEditError(null)} aria-label="Dismiss">
              ×
            </button>
          )}
        </div>
      )}

      {overlay && <div className="canvas-overlay">{overlay}</div>}

      {menuOpen && !showVariants && <AddFrameMenu onAdd={addFrame} onClose={() => setMenuOpen(false)} />}

      {!showVariants && (
        <div className="canvas-toolbar" role="toolbar" aria-label="Canvas tools">
          {TOOLS.map((t) => (
            <button key={t.id} className="tool-btn" aria-pressed={tool === t.id} onClick={() => setTool(t.id)} title={`${t.label} (${t.key})`}>
              {t.label}
              <span className="kbd">{t.key}</span>
            </button>
          ))}
          <span className="sep" />
          <button
            className="tool-btn"
            onClick={() => setMenuOpen((o) => !o)}
            aria-expanded={menuOpen}
            title="Add frame (F)"
            disabled={!frames || frames.length >= FRAME_LIMITS.count || preview !== null}
          >
            + Frame
            <span className="kbd">
              {frames?.length ?? 0}/{FRAME_LIMITS.count}
            </span>
          </button>
          <button className="tool-btn" onClick={() => frames && changeFrames(arrangeRow(frames))} title="Arrange all in a row" disabled={!frames?.length || preview !== null}>
            Arrange
          </button>
          <span className="sep" />
          <button className="tool-btn tool-icon" onClick={() => zoomTo(stepZoom(view.zoom, -1))} aria-label="Zoom out" title="Zoom out (−)" disabled={view.zoom <= ZOOM_MIN}>
            −
          </button>
          <button className="tool-btn zoom-value" onClick={() => zoomTo(1)} title="Zoom to 100% (0)" aria-label={`Zoom ${Math.round(view.zoom * 100)}%. Set to 100%`}>
            {Math.round(view.zoom * 100)}%
          </button>
          <button className="tool-btn tool-icon" onClick={() => zoomTo(stepZoom(view.zoom, 1))} aria-label="Zoom in" title="Zoom in (+)" disabled={view.zoom >= ZOOM_MAX}>
            +
          </button>
          <button className="tool-btn" onClick={fit} title="Fit all (⇧1)">
            Fit<span className="kbd">⇧1</span>
          </button>
        </div>
      )}
    </main>
  );
}
