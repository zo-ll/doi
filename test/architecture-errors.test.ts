import { expect, test } from "bun:test";
import { createDiagram, diagramSchema } from "../src/architecture/schema.ts";
import { createNode, type DiagramNode } from "../src/architecture/nodes.ts";
import { createEdge, edgeSchema } from "../src/architecture/edges.ts";
import { architectureErrorMessage } from "../src/architecture/errors.ts";
import { readDiagramFile } from "../src/architecture/interchange.ts";

test("validation errors name the field and a short rule", () => {
  const node = createNode("box", { x: 0, y: 0 });
  const cases: [Partial<DiagramNode>, string][] = [
    [{ name: "" }, "Box 1 name: Enter a value."],
    [{ name: "x".repeat(201) }, "Box 1 name: Use at most 200 characters."],
    [{ content: "x".repeat(20001) }, "Box 1 content: Use at most 20000 characters."],
  ];
  for (const [patch, message] of cases) {
    const result = diagramSchema.safeParse({ ...createDiagram(), nodes: [{ ...node, ...patch }] });
    expect(result.success).toBe(false);
    if (!result.success) expect(architectureErrorMessage(result.error)).toBe(message);
  }
  const edge = edgeSchema.safeParse({ ...createEdge("a", "b"), endLabel: "x".repeat(501) });
  if (edge.success) throw new Error("The oversized label passed validation.");
  expect(architectureErrorMessage(edge.error)).toBe("Diagram end label: Use at most 500 characters.");
});
test("invalid JSON and imported duplicate ids remain readable", () => {
  const node = createNode("box", { x: 0, y: 0 });
  try { readDiagramFile(JSON.stringify({ format: "doi-diagram", version: 1, diagram: { ...createDiagram(), nodes: [node, node] } })); throw new Error("Unexpected valid file"); }
  catch (error) { expect(architectureErrorMessage(error)).toBe("Box 2 id: Item ids must be unique."); }
  expect(architectureErrorMessage(new SyntaxError("raw engine error"))).toBe("The diagram file must contain valid JSON.");
  expect(architectureErrorMessage(new Error("The diagram changed elsewhere."))).toBe("The diagram changed elsewhere.");
});
