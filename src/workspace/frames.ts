// No Node imports here: the web bundle uses these too.

/** One frame on the canvas: a viewport size and a place, in canvas pixels. */
export interface Frame {
  id: string;
  label: string;
  width: number;
  height: number;
  x: number;
  y: number;
}

export const FRAME_LIMITS = { min: 200, maxWidth: 3840, maxHeight: 4000, count: 12, label: 40, coord: 100_000 } as const;

/** Viewport presets. The first two are the default layout of a new design. */
export const PRESETS = [
  { label: "Desktop", width: 1440, height: 900 },
  { label: "Mobile", width: 390, height: 844 },
  { label: "Laptop", width: 1024, height: 768 },
  { label: "Tablet", width: 768, height: 1024 },
  { label: "Slide", width: 1920, height: 1080 },
] as const;

/** Space between frames, in canvas pixels. */
export const FRAME_GAP = 80;

export function defaultLayout(): Frame[] {
  const [desktop, mobile] = PRESETS;
  return [
    { id: "desktop", ...desktop, x: 0, y: 0 },
    { id: "mobile", ...mobile, x: desktop.width + FRAME_GAP, y: 0 },
  ];
}

/** The layout of a slide deck: one 16:9 frame. */
export function slideLayout(): Frame[] {
  const slide = PRESETS[4];
  return [{ id: "slide", ...slide, x: 0, y: 0 }];
}

const ID = /^[a-z0-9-]{1,40}$/;
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** The frames, or a message that says what is wrong. */
export function parseLayout(raw: unknown): Frame[] | string {
  if (!Array.isArray(raw)) return "frames must be a list.";
  if (raw.length < 1 || raw.length > FRAME_LIMITS.count) return `A design has 1 to ${FRAME_LIMITS.count} frames.`;
  const ids = new Set<string>();
  const out: Frame[] = [];
  for (const f of raw) {
    const { id, label, width, height, x, y } = (f ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || !ID.test(id) || ids.has(id)) return "Each frame needs a unique id (a-z, 0-9, -).";
    if (typeof label !== "string" || !label.trim() || label.length > FRAME_LIMITS.label) {
      return `A frame label has 1 to ${FRAME_LIMITS.label} characters.`;
    }
    if (!isInt(width, FRAME_LIMITS.min, FRAME_LIMITS.maxWidth) || !isInt(height, FRAME_LIMITS.min, FRAME_LIMITS.maxHeight)) {
      return `A frame is ${FRAME_LIMITS.min} to ${FRAME_LIMITS.maxWidth} pixels wide and ${FRAME_LIMITS.min} to ${FRAME_LIMITS.maxHeight} pixels high.`;
    }
    if (!isInt(x, -FRAME_LIMITS.coord, FRAME_LIMITS.coord) || !isInt(y, -FRAME_LIMITS.coord, FRAME_LIMITS.coord)) {
      return "A frame position must be whole numbers on the canvas.";
    }
    ids.add(id);
    out.push({ id, label: label.trim(), width, height, x, y });
  }
  return out;
}
