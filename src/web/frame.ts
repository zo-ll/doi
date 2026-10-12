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
  | { type: "doi:rects"; selected: Rect | null; hover: { oid: string; rect: Rect } | null };

/** The same form as the server accepts for a turn target. */
const OID = /^[A-Za-z0-9_-]{1,100}$/;

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
    case "doi:select":
      return isOid(d.oid) ? { type: "doi:select", oid: d.oid } : null;
    case "doi:rects": {
      const selected = rect(d.selected);
      if (selected === undefined) return null;
      // A bad hover (an element with an invalid id) only hides the hover outline.
      const h = (typeof d.hover === "object" ? d.hover : null) as Record<string, unknown> | null;
      const r = h ? rect(h.rect) : null;
      const hover = h && isOid(h.oid) && r ? { oid: h.oid, rect: r } : null;
      return { type: "doi:rects", selected, hover };
    }
    default:
      return null;
  }
}

/** The message that tells a frame which element is selected. */
export const trackMessage = (oid: string | null) => ({ type: "doi:track", oid }) as const;
