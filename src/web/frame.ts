// Messages between the app and the bridge script in each design frame (src/frame/bridge.js).
// A design page can run its own scripts, so the app checks each message before it uses it.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How the parent of the selected element lays it out, for a canvas edit (#66). */
export interface Layout {
  /** flex, grid, or normal flow. */
  kind: "flex" | "grid" | "flow";
  /** The axis the siblings follow: a flex direction, both for a grid, the block axis for flow. */
  direction: "row" | "column" | "grid";
  margins: { top: number; right: number; bottom: number; left: number };
  /** Padding and border that a CSS width or height does not count (content-box), in px. */
  extra: { x: number; y: number };
  /** The other children of the parent that have a data-oid, in DOM order. */
  siblings: { oid: string; rect: Rect }[];
  /** How many of the siblings come before the element. */
  index: number;
}

export type FrameMessage =
  | { type: "doi:ready" }
  | { type: "doi:select"; oid: string }
  | { type: "doi:clear" }
  /** A pinch or Ctrl/⌘ + wheel over the page; x and y in the frame's viewport. */
  | { type: "doi:wheel"; deltaY: number; x: number; y: number }
  /** A canvas key pressed while the frame has the focus. */
  | { type: "doi:key"; key: string; down: boolean; shift: boolean; mod: boolean }
  | {
      type: "doi:rects";
      selected: Rect | null;
      /** Null when nothing is selected, or from an old bridge. */
      layout: Layout | null;
      hover: { oid: string; rect: Rect } | null;
      /** Boxes of the elements with open comments that this frame shows. */
      pins: Record<string, Rect>;
    };

/** The same form as the server accepts for a turn target. */
const OID = /^[A-Za-z0-9_-]{1,100}$/;

const MAX_PINS = 500;
/** Keys the canvas uses; a page cannot send other keys to the app. */
/** Keys a page may forward: canvas keys, tool keys, and the app's shortcuts (with ⌘/Ctrl). */
const CANVAS_KEYS = new Set([" ", "=", "+", "-", "0", "!", "1", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
const LETTER_KEYS = new Set(["v", "c", "h", "f", "n", "t", "p", "d", "e", "z", "[", "]", ","]);
const forwardable = (key: string) => CANVAS_KEYS.has(key) || LETTER_KEYS.has(key.toLowerCase());

const isOid = (v: unknown): v is string => typeof v === "string" && OID.test(v);

function rect(v: unknown): Rect | null | undefined {
  if (v === null) return null;
  if (typeof v !== "object") return undefined;
  const { x, y, width, height } = v as Record<string, unknown>;
  const nums = [x, y, width, height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  if ((width as number) < 0 || (height as number) < 0) return undefined;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

const MAX_SIBLINGS = 200;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A checked layout, or null when it is not one. Bad siblings are left out one by one. */
function layout(v: unknown): Layout | null {
  if (typeof v !== "object" || v === null) return null;
  const l = v as Record<string, unknown>;
  const kind = l.kind;
  const direction = l.direction;
  if (kind !== "flex" && kind !== "grid" && kind !== "flow") return null;
  if (direction !== "row" && direction !== "column" && direction !== "grid") return null;
  const m = (typeof l.margins === "object" && l.margins !== null ? l.margins : {}) as Record<string, unknown>;
  const e = (typeof l.extra === "object" && l.extra !== null ? l.extra : {}) as Record<string, unknown>;
  const siblings: Layout["siblings"] = [];
  for (const s of Array.isArray(l.siblings) ? l.siblings.slice(0, MAX_SIBLINGS) : []) {
    const sr = typeof s === "object" && s !== null ? rect((s as Record<string, unknown>).rect) : null;
    const oid = typeof s === "object" && s !== null ? (s as Record<string, unknown>).oid : null;
    if (sr && isOid(oid)) siblings.push({ oid, rect: sr });
  }
  return {
    kind,
    direction,
    margins: { top: num(m.top), right: num(m.right), bottom: num(m.bottom), left: num(m.left) },
    extra: { x: Math.max(0, num(e.x)), y: Math.max(0, num(e.y)) },
    siblings,
    index: Number.isInteger(l.index) ? Math.min(Math.max(0, l.index as number), siblings.length) : siblings.length,
  };
}

/** The message, or null when it is not a valid bridge message. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  switch (d.type) {
    case "doi:ready":
    case "doi:clear":
      return { type: d.type };
    case "doi:wheel": {
      const nums = [d.deltaY, d.x, d.y];
      if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
      return { type: "doi:wheel", deltaY: d.deltaY as number, x: d.x as number, y: d.y as number };
    }
    case "doi:key":
      if (typeof d.key !== "string" || !forwardable(d.key)) return null;
      return { type: "doi:key", key: d.key, down: d.down === true, shift: d.shift === true, mod: d.mod === true };
    case "doi:select":
      return isOid(d.oid) ? { type: "doi:select", oid: d.oid } : null;
    case "doi:rects": {
      const selected = rect(d.selected);
      if (selected === undefined) return null;
      // A bad hover (an element with an invalid id) only hides the hover outline.
      const h = (typeof d.hover === "object" ? d.hover : null) as Record<string, unknown> | null;
      const r = h ? rect(h.rect) : null;
      const hover = h && isOid(h.oid) && r ? { oid: h.oid, rect: r } : null;
      // Bad pins are left out one by one. An old bridge without pins sends none.
      // No prototype: an element may have the id "__proto__".
      const pins: Record<string, Rect> = Object.create(null);
      if (typeof d.pins === "object" && d.pins !== null) {
        for (const [oid, value] of Object.entries(d.pins).slice(0, MAX_PINS)) {
          const pr = rect(value);
          if (isOid(oid) && pr) pins[oid] = pr;
        }
      }
      return { type: "doi:rects", selected, layout: selected ? layout(d.layout) : null, hover, pins };
    }
    default:
      return null;
  }
}

/** The message that tells a frame which element is selected and which elements have pins. */
export const trackMessage = (oid: string | null, pins: string[] = []) => ({ type: "doi:track", oid, pins }) as const;
