// Canvas edits (#66) without React: what a resize, a nudge, a drag among siblings or an align
// writes. All sizes are in the frame's CSS pixels; the canvas divides screen moves by the zoom.
import type { Layout, Rect } from "./frame.ts";
import type { ElementStyle, Position, SpacingScale } from "../workspace/element-edit.ts";

export type { ElementStyle, Position, SpacingScale };
export type Handle = "e" | "s" | "se";
export type Axis = "x" | "y";
export type Place = "start" | "center" | "end";

export const DEFAULT_SCALE: SpacingScale = { unit: 4, steps: [0, 4, 8, 12, 16, 24, 32, 48, 64, 96].map((px) => ({ px, var: null })) };

/** A size snapped to a multiple of the scale's unit, at least one unit. */
export const snapSize = (px: number, unit: number) => Math.max(unit, Math.round(px / unit) * unit);

/** A margin snapped to the nearest step of the scale (the sign stays), as CSS: the step's variable when it has one. */
export function snapMargin(px: number, scale: SpacingScale): string {
  const abs = Math.abs(px);
  let best = scale.steps[0] ?? { px: 0, var: null };
  for (const s of scale.steps) if (Math.abs(s.px - abs) < Math.abs(best.px - abs)) best = s;
  if (best.px === 0) return "0px";
  if (px < 0) return `-${best.px}px`;
  return best.var ? `var(${best.var})` : `${best.px}px`;
}

/** The width and height for a resize handle moved by dx, dy from the box `start`. */
export function resizeStyle(handle: Handle, start: Rect, extra: Layout["extra"], dx: number, dy: number, unit: number): ElementStyle {
  const style: ElementStyle = {};
  // A CSS width of a content-box element does not count its padding and border.
  if (handle !== "s") style.width = `${Math.max(0, snapSize(start.width + dx, unit) - extra.x)}px`;
  if (handle !== "e") style.height = `${Math.max(0, snapSize(start.height + dy, unit) - extra.y)}px`;
  return style;
}

/** Margins for a nudge (Alt + drag) by dx, dy, snapped to the scale. */
export function nudgeStyle(margins: Layout["margins"], dx: number, dy: number, scale: SpacingScale): ElementStyle {
  const style: ElementStyle = {};
  if (dx) style["margin-left"] = snapMargin(margins.left + dx, scale);
  if (dy) style["margin-top"] = snapMargin(margins.top + dy, scale);
  return style;
}

export interface Drop {
  target: string;
  position: Position;
  /** Where the insert line goes, in the frame's viewport. */
  line: Rect;
}

const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const LINE = 2;

/**
 * The sibling to drop next to, for a pointer at `p`: the nearest sibling, and before or after
 * it along the parent's axis (a grid goes by rows, so the x position decides). Null without siblings.
 */
export function dropTarget(layout: Layout, p: { x: number; y: number }): Drop | null {
  let best: { oid: string; rect: Rect } | null = null;
  let bestDistance = Infinity;
  for (const s of layout.siblings) {
    const c = center(s.rect);
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < bestDistance) [best, bestDistance] = [s, d];
  }
  if (!best) return null;
  const r = best.rect;
  const c = center(r);
  const horizontal = layout.direction === "row" || layout.direction === "grid";
  const position: Position = (horizontal ? p.x < c.x : p.y < c.y) ? "before" : "after";
  const line = horizontal
    ? { x: (position === "before" ? r.x : r.x + r.width) - LINE / 2, y: r.y, width: LINE, height: r.height }
    : { x: r.x, y: (position === "before" ? r.y : r.y + r.height) - LINE / 2, width: r.width, height: LINE };
  return { target: best.oid, position, line };
}

/** True when the drop changes nothing: the element is already there. */
export function sameSpot(layout: Layout, self: Rect, drop: Drop): boolean {
  const all = [...layout.siblings, { oid: "", rect: self }];
  const horizontal = layout.direction === "row" || layout.direction === "grid";
  const key = (r: Rect) => (horizontal ? [r.y, r.x] : [r.y]);
  // Siblings in their visual order: by row, then by x for row and grid layouts.
  all.sort((a, b) => {
    const ka = key(a.rect);
    const kb = key(b.rect);
    return ka[0]! - kb[0]! || (ka[1] ?? 0) - (kb[1] ?? 0);
  });
  const i = all.findIndex((s) => s.oid === "");
  const t = all.findIndex((s) => s.oid === drop.target);
  return drop.position === "before" ? t === i + 1 : t === i - 1;
}

/**
 * The style that puts the element at the start, center or end of its parent on one axis.
 * Flex main axis and flow use auto margins; the cross axis and grids use align-self and justify-self.
 * Null when the layout cannot do it (the vertical axis in normal flow).
 */
export function alignStyle(layout: Layout, axis: Axis, place: Place): ElementStyle | null {
  const margins = (a: "left" | "right" | "top" | "bottom", b: "left" | "right" | "top" | "bottom"): ElementStyle => ({
    [`margin-${a}`]: place === "start" ? "0px" : "auto",
    [`margin-${b}`]: place === "end" ? "0px" : "auto",
  });
  const flexSelf = place === "start" ? "flex-start" : place === "end" ? "flex-end" : "center";
  if (layout.kind === "grid") return axis === "x" ? { "justify-self": place } : { "align-self": place };
  if (layout.kind === "flex") {
    const main = layout.direction === "row" ? "x" : "y";
    if (axis !== main) return { "align-self": flexSelf };
    return axis === "x" ? margins("left", "right") : margins("top", "bottom");
  }
  return axis === "x" ? margins("left", "right") : null;
}
