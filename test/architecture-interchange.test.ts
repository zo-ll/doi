import { expect, test } from "bun:test";
import { createDiagram } from "../src/architecture/schema.ts";
import { createNode } from "../src/architecture/nodes.ts";
import { createEdge } from "../src/architecture/edges.ts";
import { diagramFile, readDiagramFile } from "../src/architecture/interchange.ts";

test("editable diagram files round trip geometry, labels and UI links", () => {
  const a = createNode("class", { x: 1, y: 2 }, "List<T>");
  a.references.push({ design: "home", page: "index.html", node: "hero" });
  const b = createNode("box", { x: 300, y: 40 });
  const graph = { ...createDiagram(), nodes: [a, b], edges: [{ ...createEdge(a.id, b.id), endLabel: "0..*" }] };
  expect(readDiagramFile(diagramFile(graph))).toEqual(graph);
  expect(() => readDiagramFile(diagramFile(graph).replace('"version": 1', '"version": 2'))).toThrow();
  expect(() => readDiagramFile(JSON.stringify({ format: "doi-diagram", version: 1, diagram: { ...graph, nodes: [a, a] } }))).toThrow();
  expect(() => readDiagramFile(" ".repeat(4 * 1024 * 1024 + 1))).toThrow("4 MB");
});
