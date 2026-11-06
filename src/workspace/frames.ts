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

export const FRAME_LIMITS = { min: 200, maxWidth: 3840, maxHeight: 4000, count: 12, label: 40, coord: 100_000, page: 1024 } as const;

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

/** A frame on the canvas. A page frame shows its own page; other frames show the open page. */
export type ScreenFrame = Frame & { page?: string };

/** The most screens a mobile app shows side by side. */
export const MAX_SCREENS = 24;

/** The frames of a mobile app: one 390 × 844 phone frame per page, in a row, in page order. Not stored. */
export function screenFrames(pages: string[]): ScreenFrame[] {
  const phone = PRESETS[1];
  return pages.slice(0, MAX_SCREENS).map((page, i) => ({
    id: `screen-${i}`,
    label: page.replace(/\.html?$/i, ""),
    width: phone.width,
    height: phone.height,
    x: i * (phone.width + FRAME_GAP),
    y: 0,
    page,
  }));
}

/** The pages that a design with several pages shows as frames: the open page is always one of them. */
export function shownPages(pages: readonly string[], open: string): string[] {
  const first = pages.slice(0, FRAME_LIMITS.count);
  if (first.includes(open) || !pages.includes(open)) return first;
  return [...first.slice(0, -1), open];
}

const pageLabel = (page: string) => page.replace(/\.html?$/i, "").slice(0, FRAME_LIMITS.label) || page.slice(0, FRAME_LIMITS.label);

function pageFrameId(page: string, taken: Set<string>): string {
  const base = `page-${page.toLowerCase().replace(/\.html?$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "x"}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * The frames on the canvas of a web design. With one page: the stored frames without a page, as
 * before. With several pages: one Desktop frame per page in page order, each at its stored place,
 * and then the frames the user added, which show the open page. The default Desktop and Mobile
 * frames go when a design first gets several pages. Later they count as added frames, because the
 * user can add a frame with the same id.
 */
export function flowFrames(stored: readonly ScreenFrame[], pages: readonly string[]): ScreenFrame[] {
  const own = stored.filter((f) => !f.page);
  if (pages.length <= 1) return own.length ? [...own] : defaultLayout();
  const added = stored.some((f) => f.page) ? own : own.filter((f) => f.id !== "desktop" && f.id !== "mobile");
  // A page path over the limit cannot be stored, and would block every save of the layout.
  const shown = pages.filter((p) => p.length <= FRAME_LIMITS.page).slice(0, FRAME_LIMITS.count);
  const extras = added.slice(0, FRAME_LIMITS.count - shown.length);
  const saved = new Map(stored.filter((f) => f.page).map((f) => [f.page!, f]));
  const placed = shown.flatMap((p) => saved.get(p) ?? []);
  const taken = new Set([...placed, ...extras].map((f) => f.id));
  const desktop = PRESETS[0];
  let x = placed.length || extras.length ? Math.max(...[...placed, ...extras].map((f) => f.x + f.width)) + FRAME_GAP : 0;
  const y = placed.length || extras.length ? Math.min(...[...placed, ...extras].map((f) => f.y)) : 0;
  const frames = shown.map((page) => {
    const known = saved.get(page);
    if (known) return known;
    const id = pageFrameId(page, taken);
    taken.add(id);
    const frame: ScreenFrame = { id, label: pageLabel(page), width: desktop.width, height: desktop.height, x, y, page };
    x += desktop.width + FRAME_GAP;
    return frame;
  });
  return [...frames, ...extras];
}

/**
 * The viewport sizes of a design, for export, the handoff and MCP. A page frame is a place on the
 * canvas for one page, not one more size: all page frames count as one Desktop viewport.
 */
export function viewportFrames(frames: readonly ScreenFrame[]): Frame[] {
  const own = frames.filter((f) => !f.page);
  if (own.length === frames.length) return [...own];
  return own.some((f) => f.id === "desktop") ? own : [{ id: "desktop", ...PRESETS[0], x: 0, y: 0 }, ...own];
}

const ID = /^[a-z0-9-]{1,40}$/;
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** The frames, or a message that says what is wrong. */
export function parseLayout(raw: unknown): ScreenFrame[] | string {
  if (!Array.isArray(raw)) return "frames must be a list.";
  if (raw.length < 1 || raw.length > FRAME_LIMITS.count) return `A design has 1 to ${FRAME_LIMITS.count} frames.`;
  const ids = new Set<string>();
  const out: ScreenFrame[] = [];
  for (const f of raw) {
    const { id, label, width, height, x, y, page } = (f ?? {}) as Record<string, unknown>;
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
    if (page !== undefined && (typeof page !== "string" || !page || page.length > FRAME_LIMITS.page)) return "A frame's page must be a page name.";
    ids.add(id);
    out.push({ id, label: label.trim(), width, height, x, y, ...(page === undefined ? {} : { page }) });
  }
  return out;
}
