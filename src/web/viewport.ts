import { FRAME_GAP, type Frame } from "../workspace/frames.ts";

/** The camera: a screen point is `world × zoom + (x, y)`, in pixels of the canvas element. */
export interface View {
  x: number;
  y: number;
  zoom: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 4;
/** The zoom buttons and keys go through these steps. */
export const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4];
/** Canvas pixels above each frame for its label, so "fit" shows the labels too. */
export const LABEL_ROOM = 32;
/** Screen pixels around the frames after "fit". */
export const FIT_PADDING = 48;

export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** Zooms to `zoom` and keeps the world point under `at` (screen) in its place. */
export function zoomAt(view: View, zoom: number, at: Point): View {
  const z = clampZoom(zoom);
  const wx = (at.x - view.x) / view.zoom;
  const wy = (at.y - view.y) / view.zoom;
  return { x: at.x - wx * z, y: at.y - wy * z, zoom: z };
}

/** The next zoom step in or out from `zoom`. */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  const eps = 1e-6;
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > zoom + eps) : ZOOM_STEPS.findLast((s) => s < zoom - eps);
  return next ?? zoom;
}

/**
 * Zoom factor of one wheel event. A trackpad pinch sends small deltas, a mouse wheel large
 * ones; each event changes the zoom by at most a quarter.
 */
export function wheelFactor(deltaY: number): number {
  return Math.exp(Math.max(-0.25, Math.min(0.25, -deltaY * 0.01)));
}

export function boundsOf(frames: Frame[]): { x: number; y: number; width: number; height: number } | null {
  if (!frames.length) return null;
  const left = Math.min(...frames.map((f) => f.x));
  const top = Math.min(...frames.map((f) => f.y - LABEL_ROOM));
  const right = Math.max(...frames.map((f) => f.x + f.width));
  const bottom = Math.max(...frames.map((f) => f.y + f.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The view that shows all frames in `size`, centered. It never zooms in past 100%. */
export function fitView(frames: Frame[], size: Size): View {
  const b = boundsOf(frames);
  if (!b || size.width <= 0 || size.height <= 0) return { x: 0, y: 0, zoom: 1 };
  const room = { width: Math.max(1, size.width - 2 * FIT_PADDING), height: Math.max(1, size.height - 2 * FIT_PADDING) };
  const zoom = clampZoom(Math.min(1, room.width / b.width, room.height / b.height));
  return {
    x: (size.width - b.width * zoom) / 2 - b.x * zoom,
    y: (size.height - b.height * zoom) / 2 - b.y * zoom,
    zoom,
  };
}

/** A place for a new frame: right of the others, on the top line. */
export function nextPosition(frames: Frame[]): Point {
  if (!frames.length) return { x: 0, y: 0 };
  return {
    x: Math.max(...frames.map((f) => f.x + f.width)) + FRAME_GAP,
    y: Math.min(...frames.map((f) => f.y)),
  };
}

/** Puts the frames in one row, left to right in their current order, tops aligned. */
export function arrangeRow(frames: Frame[]): Frame[] {
  const order = [...frames].sort((a, b) => a.x - b.x || a.y - b.y);
  let x = 0;
  const placed = new Map<string, Frame>();
  for (const f of order) {
    placed.set(f.id, { ...f, x, y: 0 });
    x += f.width + FRAME_GAP;
  }
  return frames.map((f) => placed.get(f.id)!);
}

/** A new frame id from its label: "tablet", "tablet-2", … */
export function newFrameId(frames: Frame[], label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "frame";
  const ids = new Set(frames.map((f) => f.id));
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  return id;
}

