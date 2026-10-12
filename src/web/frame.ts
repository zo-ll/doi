// Messages between the app and the bridge script in each design frame (src/frame/bridge.js).
// A design page can run its own scripts, so the app checks each message before it uses it.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
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
      hover: { oid: string; rect: Rect } | null;
      /** Boxes of the elements with open comments that this frame shows. */
      pins: Record<string, Rect>;
    };

/** The same form as the server accepts for a turn target. */
const OID = /^[A-Za-z0-9_-]{1,100}$/;

const MAX_PINS = 500;
/** Keys the canvas uses; a page cannot send other keys to the app. */
const CANVAS_KEYS = new Set([" ", "=", "+", "-", "0", "!", "1", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

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
      if (typeof d.key !== "string" || !CANVAS_KEYS.has(d.key)) return null;
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
      return { type: "doi:rects", selected, hover, pins };
    }
    default:
      return null;
  }
}

/** The message that tells a frame which element is selected and which elements have pins. */
export const trackMessage = (oid: string | null, pins: string[] = []) => ({ type: "doi:track", oid, pins }) as const;
