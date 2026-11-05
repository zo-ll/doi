import { expect, test } from "bun:test";
import { createNode } from "../src/architecture/nodes.ts";
import { createEdge } from "../src/architecture/edges.ts";
import { createDiagram, diagramSchema } from "../src/architecture/schema.ts";
import { duplicateItems, removeItems } from "../src/architecture/edit.ts";

test("copies get fresh ids, independent values and remapped internal connections", () => {
  const a = createNode("box", { x: 20, y: 30 });
  const b = createNode("box", { x: 300, y: 30 });
  const graph = { ...createDiagram(), nodes: [a, b], edges: [createEdge(a.id, b.id)] };
  const result = duplicateItems(graph, new Set([a.id, b.id]));
  expect(result.ids.size).toBe(2);
  expect(result.graph.nodes).toHaveLength(4);
  const edge = result.graph.edges[1];
  expect(edge && result.ids.has(edge.source) && result.ids.has(edge.target)).toBe(true);
  expect(diagramSchema.safeParse(result.graph).success).toBe(true);
  result.graph.nodes[2]?.references.push({ design: "home", page: "index.html", node: null });
  expect(a.references).toHaveLength(0);
});

test("deleting a group preserves child positions, comments and locked items", () => {
  const group = createNode("group", { x: 100, y: 200 });
  const child = { ...createNode("box", { x: 20, y: 30 }), parent: group.id };
  const locked = { ...createNode("box", { x: 1, y: 1 }), locked: true };
  const graph = { ...createDiagram(), nodes: [group, child, locked], edges: [createEdge(group.id, child.id)] };
  const result = removeItems(graph, new Set([group.id, locked.id]));
  expect(result.nodes.find(n => n.id === child.id)?.position).toEqual({ x: 120, y: 230 });
  expect(result.nodes.find(n => n.id === child.id)?.parent).toBeNull();
  expect(result.nodes.some(n => n.id === locked.id)).toBe(true);
  expect(result.edges).toHaveLength(0);
  expect(diagramSchema.safeParse(result).success).toBe(true);
});
