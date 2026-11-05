import { z } from "zod";
import { edgeSchema } from "./edges.ts";
import { createNode, nodeSchema, type DiagramNode, type Point } from "./nodes.ts";
import { diagramSchema, type Diagram } from "./schema.ts";

const LIMIT = 100_000, MAX_SIZE = 4096;
/** The schema allows 20 nested groups; walks stop one level after that. */
const MAX_WALK = 21;
const clamp = (value: number) => Math.max(-LIMIT, Math.min(LIMIT, value));

/** The canvas position of a node: its own position plus the positions of its groups. */
export function absolutePosition(graph: Diagram, id: string): Point {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  let node = byId.get(id), x = 0, y = 0, depth = 0;
  while (node && depth++ <= MAX_WALK) { x += node.position.x; y += node.position.y; node = node.parent ? byId.get(node.parent) : undefined; }
  return { x, y };
}
/** Canvas positions of every node, with one parent map: O(nodes × nesting depth). */
function absolutePositions(graph: Diagram): Map<string, Point> {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const out = new Map<string, Point>();
  const resolve = (node: DiagramNode, depth: number): Point => {
    const known = out.get(node.id);
    if (known) return known;
    const parent = node.parent ? byId.get(node.parent) : undefined;
    const origin = parent && depth <= MAX_WALK ? resolve(parent, depth + 1) : { x: 0, y: 0 };
    const point = { x: origin.x + node.position.x, y: origin.y + node.position.y };
    out.set(node.id, point);
    return point;
  };
  for (const node of graph.nodes) resolve(node, 0);
  return out;
}
/**
 * Unlocked nodes in the selection, in graph order, without the nodes that move with a selected group.
 * One parent map per call: the walk is O(nodes × nesting depth).
 */
export function movableNodes(graph: Diagram, ids: ReadonlySet<string>): DiagramNode[] {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const unlocked = new Set(graph.nodes.filter(n => ids.has(n.id) && !n.locked).map(n => n.id));
  const inside = (node: DiagramNode) => {
    let parent = node.parent, depth = 0;
    while (parent && depth++ <= MAX_WALK) { if (unlocked.has(parent)) return true; parent = byId.get(parent)?.parent ?? null; }
    return false;
  };
  return graph.nodes.filter(n => unlocked.has(n.id) && !inside(n));
}
function moveTo(graph: Diagram, targets: ReadonlyMap<string, Point>): Diagram {
  const positions = absolutePositions(graph);
  return { ...graph, nodes: graph.nodes.map(node => {
    const target = targets.get(node.id);
    if (!target) return node;
    const origin = node.parent ? positions.get(node.parent) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
    return { ...node, position: { x: clamp(Math.round(target.x - origin.x)), y: clamp(Math.round(target.y - origin.y)) } };
  }) };
}

export const alignModes = ["left", "centre", "right", "top", "middle", "bottom"] as const;
export type AlignMode = typeof alignModes[number];
/** Align the unlocked selected boxes on the canvas. Two or more boxes are necessary. */
export function alignItems(graph: Diagram, ids: ReadonlySet<string>, mode: AlignMode): Diagram {
  const nodes = movableNodes(graph, ids);
  if (nodes.length < 2) return graph;
  const positions = absolutePositions(graph);
  const boxes = nodes.map(n => ({ n, p: positions.get(n.id) ?? n.position }));
  const left = Math.min(...boxes.map(b => b.p.x)), right = Math.max(...boxes.map(b => b.p.x + b.n.size.width));
  const top = Math.min(...boxes.map(b => b.p.y)), bottom = Math.max(...boxes.map(b => b.p.y + b.n.size.height));
  const targets = new Map(boxes.map(({ n, p }) => {
    const { width, height } = n.size;
    const x = mode === "left" ? left : mode === "right" ? right - width : mode === "centre" ? (left + right) / 2 - width / 2 : p.x;
    const y = mode === "top" ? top : mode === "bottom" ? bottom - height : mode === "middle" ? (top + bottom) / 2 - height / 2 : p.y;
    return [n.id, { x, y }];
  }));
  return moveTo(graph, targets);
}

/** Make the gaps between the unlocked selected boxes equal. Three or more boxes are necessary. */
export function distributeItems(graph: Diagram, ids: ReadonlySet<string>, axis: "horizontal" | "vertical"): Diagram {
  const nodes = movableNodes(graph, ids);
  if (nodes.length < 3) return graph;
  const key = axis === "horizontal" ? "x" : "y", size = axis === "horizontal" ? "width" : "height";
  const positions = absolutePositions(graph);
  const boxes = nodes.map(n => ({ n, p: positions.get(n.id) ?? n.position })).toSorted((a, b) => a.p[key] - b.p[key]);
  const first = boxes[0], last = boxes.at(-1);
  if (!first || !last) return graph;
  const span = last.p[key] + last.n.size[size] - first.p[key];
  const gap = (span - boxes.reduce((sum, b) => sum + b.n.size[size], 0)) / (boxes.length - 1);
  let cursor = first.p[key];
  const targets = new Map<string, Point>();
  for (const { n, p } of boxes) { targets.set(n.id, { ...p, [key]: cursor }); cursor += n.size[size] + gap; }
  return moveTo(graph, targets);
}

/** Move the unlocked selected boxes. A box inside a moved group moves with the group only. */
export function nudgeItems(graph: Diagram, ids: ReadonlySet<string>, dx: number, dy: number): Diagram {
  const moved = new Set(movableNodes(graph, ids).map(n => n.id));
  return { ...graph, nodes: graph.nodes.map(node => !moved.has(node.id) ? node : { ...node, position: { x: clamp(node.position.x + dx), y: clamp(node.position.y + dy) } }) };
}

export const orderModes = ["front", "forward", "backward", "back"] as const;
export type OrderMode = typeof orderModes[number];
/** Change the draw order of unlocked boxes. A later node in `graph.nodes` draws above an earlier one. */
export function reorderItems(graph: Diagram, selection: ReadonlySet<string>, mode: OrderMode): Diagram {
  const ids = new Set(graph.nodes.filter(n => selection.has(n.id) && !n.locked).map(n => n.id));
  const picked = graph.nodes.filter(n => ids.has(n.id)), rest = graph.nodes.filter(n => !ids.has(n.id));
  if (!picked.length) return graph;
  if (mode === "front") return { ...graph, nodes: [...rest, ...picked] };
  if (mode === "back") return { ...graph, nodes: [...picked, ...rest] };
  const nodes = [...graph.nodes];
  const step = mode === "forward" ? 1 : -1;
  const indexes = nodes.flatMap((n, i) => ids.has(n.id) ? [i] : []);
  for (const i of step > 0 ? indexes.toReversed() : indexes) {
    const j = i + step, here = nodes[i], there = nodes[j];
    if (!here || !there || ids.has(there.id)) continue;
    nodes[i] = there; nodes[j] = here;
  }
  return { ...graph, nodes };
}

export type GroupResult = { graph: Diagram; group: string } | { error: string };
/** Put the selected boxes into a new group. The boxes keep their canvas positions and connections. */
export function groupItems(graph: Diagram, ids: ReadonlySet<string>, padding = 32): GroupResult {
  const nodes = graph.nodes.filter(n => ids.has(n.id));
  if (nodes.length < 1) return { error: "Select one or more boxes to group." };
  if (nodes.some(n => n.locked)) return { error: "Unlock the selected boxes before you group them." };
  const parent = nodes[0]?.parent ?? null;
  if (nodes.some(n => n.parent !== parent)) return { error: "Select boxes inside the same group." };
  if (graph.nodes.length >= 2000) return { error: "The diagram has the maximum of 2000 boxes." };
  const positions = absolutePositions(graph);
  const boxes = nodes.map(n => ({ n, p: positions.get(n.id) ?? n.position }));
  const left = Math.min(...boxes.map(b => b.p.x)) - padding, top = Math.min(...boxes.map(b => b.p.y)) - padding * 1.5;
  const right = Math.max(...boxes.map(b => b.p.x + b.n.size.width)) + padding, bottom = Math.max(...boxes.map(b => b.p.y + b.n.size.height)) + padding;
  const origin = parent ? positions.get(parent) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
  const position = { x: Math.round(left - origin.x), y: Math.round(top - origin.y) };
  const size = { width: Math.round(right - left), height: Math.round(bottom - top) };
  if (size.width > MAX_SIZE || size.height > MAX_SIZE) return { error: `A group can be at most ${MAX_SIZE} px wide and high. Select boxes that are closer together.` };
  if (Math.abs(position.x) > LIMIT || Math.abs(position.y) > LIMIT) return { error: "Move the boxes away from the edge of the canvas before you group them." };
  const group = { ...createNode("group", { x: 0, y: 0 }, "Group"), parent, position, size };
  const first = graph.nodes.findIndex(n => ids.has(n.id));
  const members = new Set(nodes.map(n => n.id));
  const updated = graph.nodes.map(n => members.has(n.id) ? { ...n, parent: group.id, position: { x: Math.round((positions.get(n.id)?.x ?? 0) - left), y: Math.round((positions.get(n.id)?.y ?? 0) - top) } } : n);
  const next = { ...graph, nodes: [...updated.slice(0, first), group, ...updated.slice(first)] };
  const checked = diagramSchema.safeParse(next);
  if (checked.success) return { graph: next, group: group.id };
  const nesting = checked.error.issues.some(issue => issue.path.at(-1) === "parent");
  return { error: nesting ? "This group would exceed the limit of 20 nested groups." : "The group does not fit the diagram limits." };
}

/** Remove the selected groups. Their boxes keep their canvas positions. Connectors to a group block the action. */
export function ungroupItems(graph: Diagram, ids: ReadonlySet<string>): { graph: Diagram; children: Set<string> } | { error: string } {
  const groups = graph.nodes.filter(n => ids.has(n.id) && n.shape === "group");
  if (!groups.length) return { error: "Select a group to ungroup." };
  if (groups.some(g => g.locked)) return { error: "Unlock the group before you ungroup it." };
  const removed = new Set(groups.map(g => g.id));
  if (graph.edges.some(e => removed.has(e.source) || removed.has(e.target))) return { error: "Remove the connectors of the group before you ungroup it." };
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const children = new Set<string>();
  const nodes = graph.nodes.filter(n => !removed.has(n.id)).map(node => {
    let parent = node.parent, position = node.position;
    while (parent && removed.has(parent)) {
      const group = byId.get(parent);
      if (!group) break;
      position = { x: position.x + group.position.x, y: position.y + group.position.y };
      parent = group.parent;
    }
    if (parent === node.parent) return node;
    children.add(node.id);
    return { ...node, parent, position };
  });
  return { graph: { ...graph, nodes, comments: graph.comments.filter(c => !removed.has(c.item)) }, children };
}

/** Guides for a box that moves: lines where its edges or centre meet those of a sibling box. */
export type Guide = { axis: "x" | "y"; at: number };
export function snapToGuides(graph: Diagram, id: string, position: Point, threshold: number): { position: Point; guides: Guide[] } {
  const node = graph.nodes.find(n => n.id === id);
  if (!node) return { position, guides: [] };
  const siblings = graph.nodes.filter(n => n.id !== id && n.parent === node.parent);
  const { width, height } = node.size;
  let best = { x: { delta: threshold + 1, at: 0 }, y: { delta: threshold + 1, at: 0 } };
  for (const other of siblings) {
    // Like with like: start edges, centres and end edges of the two boxes, plus the edge-to-edge contact lines.
    const xs: [number, number][] = [[other.position.x, 0], [other.position.x + other.size.width / 2, width / 2], [other.position.x + other.size.width, width], [other.position.x + other.size.width, 0], [other.position.x, width]];
    const ys: [number, number][] = [[other.position.y, 0], [other.position.y + other.size.height / 2, height / 2], [other.position.y + other.size.height, height], [other.position.y + other.size.height, 0], [other.position.y, height]];
    for (const [at, offset] of xs) {
      const delta = at - (position.x + offset);
      if (Math.abs(delta) < Math.abs(best.x.delta)) best = { ...best, x: { delta, at } };
    }
    for (const [at, offset] of ys) {
      const delta = at - (position.y + offset);
      if (Math.abs(delta) < Math.abs(best.y.delta)) best = { ...best, y: { delta, at } };
    }
  }
  const guides: Guide[] = [], next = { ...position };
  if (Math.abs(best.x.delta) <= threshold) { next.x += best.x.delta; guides.push({ axis: "x", at: best.x.at }); }
  if (Math.abs(best.y.delta) <= threshold) { next.y += best.y.delta; guides.push({ axis: "y", at: best.y.at }); }
  return { position: next, guides };
}

/** Clipboard data: the selected boxes, their nested boxes and the connectors between them. */
export const CLIPBOARD_FORMAT = "doi-diagram-clipboard";
const clipboardSchema = z.strictObject({
  format: z.literal(CLIPBOARD_FORMAT), version: z.literal(1),
  nodes: z.array(nodeSchema).min(1).max(2000), edges: z.array(edgeSchema).max(4000),
});
export type Clipboard = z.infer<typeof clipboardSchema>;
export function copyItems(graph: Diagram, ids: ReadonlySet<string>): Clipboard | null {
  const included = new Set(graph.nodes.filter(n => ids.has(n.id)).map(n => n.id));
  for (let depth = 0; depth < MAX_WALK; depth++) {
    const before = included.size;
    for (const node of graph.nodes) if (node.parent && included.has(node.parent)) included.add(node.id);
    if (before === included.size) break;
  }
  if (!included.size) return null;
  const positions = absolutePositions(graph);
  const nodes = graph.nodes.filter(n => included.has(n.id)).map(node => {
    if (node.parent && included.has(node.parent)) return structuredClone(node);
    return { ...structuredClone(node), parent: null, position: positions.get(node.id) ?? node.position };
  });
  const edges = graph.edges.filter(e => included.has(e.source) && included.has(e.target)).map(e => structuredClone(e));
  return { format: CLIPBOARD_FORMAT, version: 1, nodes, edges };
}
export function readClipboard(text: string): Clipboard | null {
  try { const result = clipboardSchema.safeParse(JSON.parse(text)); return result.success ? result.data : null; }
  catch { return null; }
}
/** Paste copies with new ids. Top-level copies move by `offset`. The result passes the diagram schema or the paste fails. */
export function pasteItems(graph: Diagram, clip: Clipboard, offset: Point): { graph: Diagram; ids: Set<string> } | { error: string } {
  if (graph.nodes.length + clip.nodes.length > 2000 || graph.edges.length + clip.edges.length > 4000) return { error: "The paste would exceed the diagram limits." };
  const remap = new Map(clip.nodes.map(n => [n.id, crypto.randomUUID()]));
  const nodes = clip.nodes.map(node => {
    const parent = node.parent ? remap.get(node.parent) ?? null : null;
    const position = parent ? node.position : { x: clamp(node.position.x + offset.x), y: clamp(node.position.y + offset.y) };
    return { ...node, id: remap.get(node.id) ?? crypto.randomUUID(), parent, position, locked: false };
  });
  const edges = clip.edges.flatMap(edge => {
    const source = remap.get(edge.source), target = remap.get(edge.target);
    return source && target ? [{ ...edge, id: crypto.randomUUID(), source, target, locked: false }] : [];
  });
  const next = { ...graph, nodes: [...graph.nodes, ...nodes], edges: [...graph.edges, ...edges] };
  const checked = diagramSchema.safeParse(next);
  if (!checked.success) return { error: "The clipboard data does not fit this diagram." };
  return { graph: next, ids: new Set(nodes.filter(n => !n.parent).map(n => n.id)) };
}
