import { expect, test } from "bun:test";
import { createNode } from "../src/architecture/nodes.ts";
import { createEdge } from "../src/architecture/edges.ts";
import { architectureSchema, createDiagram, diagramSchema, emptyArchitecture } from "../src/architecture/schema.ts";

test("architecture is optional and versioned; each graph has independent data", () => {
  const state = emptyArchitecture();
  expect(state).toEqual({ version: 1, enabled: false, diagrams: [] });
  state.diagrams.push(createDiagram());
  expect(emptyArchitecture().diagrams).toEqual([]);
  expect(architectureSchema.safeParse({ ...state, version: 2 }).success).toBe(false);
  expect(architectureSchema.safeParse({ ...state, diagrams: [state.diagrams[0], state.diagrams[0]] }).success).toBe(false);
});

test("graph validation rejects duplicate ids, dangling edges and invalid group ancestry", () => {
  const a = createNode("group", { x: 0, y: 0 });
  const b = createNode("group", { x: 10, y: 10 });
  const graph = { ...createDiagram(), nodes: [a, b], edges: [createEdge(a.id, b.id)] };
  expect(diagramSchema.safeParse(graph).success).toBe(true);
  expect(diagramSchema.safeParse({ ...graph, nodes: [a, a] }).success).toBe(false);
  expect(diagramSchema.safeParse({ ...graph, nodes: [a] }).success).toBe(false);
  expect(diagramSchema.safeParse({ ...graph, nodes: [{ ...a, parent: b.id }, { ...b, parent: a.id }] }).success).toBe(false);
  expect(diagramSchema.safeParse({ ...graph, nodes: [{ ...a, parent: "missing" }, b] }).success).toBe(false);
  expect(diagramSchema.safeParse({ ...graph, nodes: [{ ...a, parent: b.id }, { ...b, shape: "box" }] }).success).toBe(false);
  const comment = { id: "comment", item: "removed-item", text: "Keep this note", createdAt: new Date().toISOString() };
  expect(diagramSchema.parse({ ...graph, comments: [comment] }).comments[0]?.item).toBe("removed-item");
});
