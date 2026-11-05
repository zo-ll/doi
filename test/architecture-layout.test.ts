import { expect, test } from "bun:test";
import { createDiagram, diagramSchema, type Diagram } from "../src/architecture/schema.ts";
import { createNode, type DiagramNode } from "../src/architecture/nodes.ts";
import { createEdge } from "../src/architecture/edges.ts";
import { absolutePosition, alignItems, copyItems, distributeItems, groupItems, nudgeItems, pasteItems, readClipboard, reorderItems, snapToGuides, ungroupItems } from "../src/architecture/layout.ts";

function box(name: string, x: number, y: number, width = 100, height = 50): DiagramNode {
  const node = createNode("box", { x, y }, name); node.size = { width, height }; return node;
}
function graphOf(nodes: DiagramNode[], edges = [] as Diagram["edges"]): Diagram {
  return diagramSchema.parse({ ...createDiagram(), nodes, edges });
}
const ids = (...nodes: DiagramNode[]) => new Set(nodes.map(n => n.id));
const at = (g: Diagram, n: DiagramNode) => absolutePosition(g, n.id);

test("align uses canvas positions and skips locked boxes", () => {
  const a = box("A", 10, 0), b = box("B", 50, 40, 200), c = box("C", 400, 90);
  c.locked = true;
  const g = graphOf([a, b, c]);
  const left = alignItems(g, ids(a, b, c), "left");
  expect([at(left, a).x, at(left, b).x, at(left, c).x]).toEqual([10, 10, 400]);
  const right = alignItems(g, ids(a, b), "right");
  expect([at(right, a).x, at(right, b).x]).toEqual([150, 50]);
  const middle = alignItems(g, ids(a, b), "middle");
  expect([at(middle, a).y, at(middle, b).y]).toEqual([20, 20]);
  expect(alignItems(g, ids(a), "left")).toBe(g);
});

test("align converts back to positions inside a group", () => {
  const a = box("A", 0, 0), b = box("B", 300, 100);
  const grouped = groupItems(graphOf([a, b]), ids(b));
  if ("error" in grouped) throw new Error(grouped.error);
  const aligned = alignItems(grouped.graph, ids(a, b), "top");
  expect(at(aligned, b)).toEqual({ x: 300, y: 0 });
  expect(diagramSchema.safeParse(aligned).success).toBe(true);
});

test("distribute makes equal gaps between the outer boxes", () => {
  const a = box("A", 0, 0), b = box("B", 130, 0), c = box("C", 400, 0, 60);
  const g = distributeItems(graphOf([c, a, b]), ids(a, b, c), "horizontal");
  expect([at(g, a).x, at(g, b).x, at(g, c).x]).toEqual([0, 200, 400]);
  expect(distributeItems(g, ids(a, b), "vertical")).toBe(g);
});

test("nudge moves a group once and keeps its children relative", () => {
  const a = box("A", 0, 0), b = box("B", 200, 0);
  const grouped = groupItems(graphOf([a, b]), ids(a));
  if ("error" in grouped) throw new Error(grouped.error);
  const group = grouped.graph.nodes.find(n => n.id === grouped.group);
  if (!group) throw new Error("No group");
  const before = at(grouped.graph, a);
  const moved = nudgeItems(grouped.graph, new Set([group.id, a.id]), 16, -1);
  expect(at(moved, a)).toEqual({ x: before.x + 16, y: before.y - 1 });
});

test("draw order moves boxes to the front, back and by one step", () => {
  const [a, b, c, d] = ["A", "B", "C", "D"].map((n, i) => box(n, i * 10, 0));
  if (!a || !b || !c || !d) throw new Error("Missing box");
  const g = graphOf([a, b, c, d]);
  const names = (x: Diagram) => x.nodes.map(n => n.name).join("");
  expect(names(reorderItems(g, ids(a), "front"))).toBe("BCDA");
  expect(names(reorderItems(g, ids(d), "back"))).toBe("DABC");
  expect(names(reorderItems(g, ids(a, b), "forward"))).toBe("CABD");
  expect(names(reorderItems(g, ids(c, d), "backward"))).toBe("ACDB");
  expect(names(reorderItems(g, ids(d), "forward"))).toBe("ABCD");
});

test("group and ungroup keep canvas positions, ids and connectors", () => {
  const a = box("A", 40, 60), b = box("B", 300, 200), c = box("C", 600, 0);
  const edge = createEdge(a.id, c.id);
  const g = graphOf([a, b, c], [edge]);
  const grouped = groupItems(g, ids(a, b));
  if ("error" in grouped) throw new Error(grouped.error);
  expect(diagramSchema.safeParse(grouped.graph).success).toBe(true);
  expect(at(grouped.graph, a)).toEqual({ x: 40, y: 60 });
  expect(at(grouped.graph, b)).toEqual({ x: 300, y: 200 });
  expect(grouped.graph.edges).toEqual([edge]);
  const group = grouped.graph.nodes.find(n => n.id === grouped.group);
  expect(group?.shape).toBe("group");
  expect(group && group.position.x < 40 && group.position.y < 60).toBe(true);
  const ungrouped = ungroupItems(grouped.graph, new Set([grouped.group]));
  if ("error" in ungrouped) throw new Error(ungrouped.error);
  expect(ungrouped.graph.nodes.map(n => [n.id, n.parent, n.position])).toEqual(g.nodes.map(n => [n.id, null, n.position]));
  expect(ungrouped.children).toEqual(ids(a, b));
});

test("group and ungroup refuse unsafe selections", () => {
  const a = box("A", 0, 0), b = box("B", 200, 0);
  const grouped = groupItems(graphOf([a, b]), ids(a));
  if ("error" in grouped) throw new Error(grouped.error);
  expect(groupItems(grouped.graph, ids(a, b))).toEqual({ error: "Select boxes inside the same group." });
  const locked = graphOf([{ ...a, locked: true }]);
  expect(groupItems(locked, ids(a))).toEqual({ error: "Unlock the selected boxes before you group them." });
  expect(ungroupItems(grouped.graph, ids(b))).toEqual({ error: "Select a group to ungroup." });
  const connected = { ...grouped.graph, edges: [createEdge(grouped.group, b.id)] };
  expect(ungroupItems(connected, new Set([grouped.group]))).toEqual({ error: "Remove the connectors of the group before you ungroup it." });
});

test("guides snap a moving box to the edges and centre of a sibling", () => {
  const a = box("A", 0, 0), b = box("B", 300, 200);
  const g = graphOf([a, b]);
  const snapped = snapToGuides(g, b.id, { x: 3, y: 223 }, 6);
  expect(snapped.position).toEqual({ x: 0, y: 223 });
  expect(snapped.guides).toEqual([{ axis: "x", at: 0 }]);
  const centre = snapToGuides(g, b.id, { x: 300, y: 2 }, 6);
  expect(centre.position.y).toBe(0);
  expect(snapToGuides(g, b.id, { x: 150, y: 150 }, 6).guides).toEqual([]);
});

test("copy and paste give new ids and keep nested boxes and connectors", () => {
  const a = box("A", 0, 0), b = box("B", 300, 0), outside = box("Outside", 0, 400);
  const grouped = groupItems(graphOf([a, b, outside], [createEdge(a.id, b.id), createEdge(a.id, outside.id)]), ids(a, b));
  if ("error" in grouped) throw new Error(grouped.error);
  const clip = copyItems(grouped.graph, new Set([grouped.group]));
  if (!clip) throw new Error("Nothing copied");
  expect(clip.nodes).toHaveLength(3);
  expect(clip.edges).toHaveLength(1);
  const parsed = readClipboard(JSON.stringify(clip));
  if (!parsed) throw new Error("The clipboard did not parse");
  const pasted = pasteItems(grouped.graph, parsed, { x: 24, y: 24 });
  if ("error" in pasted) throw new Error(pasted.error);
  expect(diagramSchema.safeParse(pasted.graph).success).toBe(true);
  expect(pasted.graph.nodes).toHaveLength(7);
  expect(pasted.graph.edges).toHaveLength(3);
  const before = new Set(grouped.graph.nodes.map(n => n.id));
  expect(pasted.graph.nodes.slice(4).every(n => !before.has(n.id))).toBe(true);
  expect(pasted.ids.size).toBe(1);
  const copyA = pasted.graph.nodes.find(n => n.name === "A" && !before.has(n.id));
  if (!copyA) throw new Error("No copy");
  expect(at(pasted.graph, copyA)).toEqual({ x: at(grouped.graph, a).x + 24, y: at(grouped.graph, a).y + 24 });
});

test("copy of a nested box pastes it at the top level at its canvas position", () => {
  const a = box("A", 50, 70);
  const grouped = groupItems(graphOf([a]), ids(a));
  if ("error" in grouped) throw new Error(grouped.error);
  const clip = copyItems(grouped.graph, ids(a));
  expect(clip?.nodes[0]?.parent).toBeNull();
  expect(clip?.nodes[0]?.position).toEqual({ x: 50, y: 70 });
});

test("the clipboard reader rejects foreign and invalid data", () => {
  expect(readClipboard("plain text")).toBeNull();
  expect(readClipboard(JSON.stringify({ format: "other", version: 1, nodes: [], edges: [] }))).toBeNull();
  expect(readClipboard(JSON.stringify({ format: "doi-diagram-clipboard", version: 1, nodes: [{ id: "../x" }], edges: [] }))).toBeNull();
  const full = graphOf(Array.from({ length: 2000 }, (_, i) => box(`N${i}`, i, 0)));
  const clip = copyItems(full, new Set([full.nodes[0]?.id ?? ""]));
  if (!clip) throw new Error("Nothing copied");
  expect(pasteItems(full, clip, { x: 0, y: 0 })).toEqual({ error: "The paste would exceed the diagram limits." });
});
