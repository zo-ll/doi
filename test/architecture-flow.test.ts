import { expect, test } from "bun:test";
import { createNode } from "../src/architecture/nodes.ts";
import { createEdge } from "../src/architecture/edges.ts";
import { createDiagram, diagramSchema } from "../src/architecture/schema.ts";
import { applyGraphChanges, attachment, flowEdges, flowNodes } from "../src/web/architecture-flow.ts";

test("flow adapters preserve parents, attachment offsets and domain independence", () => {
  const group = createNode("group", { x: 0, y: 0 });
  const child = { ...createNode("box", { x: 30, y: 40 }), parent: group.id };
  const edge = { ...createEdge(child.id, group.id), sourceSide: "bottom", sourceOffset: 0.25 } satisfies ReturnType<typeof createEdge>;
  const graph = { ...createDiagram(), nodes: [child, group], edges: [edge] };
  const before = structuredClone(graph);
  const nodes = flowNodes(graph, new Set([child.id]));
  expect(nodes[0]?.id).toBe(group.id);
  expect(nodes[0]?.measured).toEqual(group.size);
  expect(nodes[0]?.measured).not.toBe(group.size);
  expect(nodes[0]?.width).toBe(group.size.width);
  expect(nodes[1]?.parentId).toBe(group.id);
  const handle = flowEdges(graph, new Set())[0]?.sourceHandle ?? null;
  expect(attachment(graph, child.id, handle, "right")).toEqual({ side: "bottom", offset: 0.25 });
  const changed = applyGraphChanges(graph, [{ id: child.id, type: "position", position: { x: 50, y: 60 } }, { id: child.id, type: "dimensions", dimensions: { width: 250, height: 140 }, setAttributes: true }]);
  expect(changed.nodes[0]?.size).toEqual({ width: 250, height: 140 });
  expect(diagramSchema.safeParse(changed).success).toBe(true);
  expect(graph).toEqual(before);
});
