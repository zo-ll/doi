import { expect, test } from "bun:test";
import { applyRelationship, createEdge, edgeSchema, relationshipSchema } from "../src/architecture/edges.ts";

test("all UML relationship presets remain independently editable", () => {
  const original = createEdge("one", "two");
  for (const preset of relationshipSchema.options) {
    const edge = applyRelationship(original, preset);
    expect(edgeSchema.parse(edge)).toEqual(edge);
    expect(edgeSchema.parse({ ...edge, startMarker: "circle", line: "dotted" }).startMarker).toBe("circle");
  }
  expect(applyRelationship(original, "inheritance").endMarker).toBe("triangle");
  expect(applyRelationship(original, "composition").startMarker).toBe("diamond-filled");
  expect(original.endMarker).toBe("arrow");
});

test("connectors reject unsafe markers, coordinates, labels and attachment offsets", () => {
  const edge = createEdge("one", "two");
  for (const patch of [{ startMarker: "<script>" }, { sourceOffset: 2 }, { width: 0 },
    { points: [{ x: NaN, y: 1 }] }, { endLabel: "a".repeat(501) }, { colour: "red;display:none" }]) {
    expect(edgeSchema.safeParse({ ...edge, ...patch }).success).toBe(false);
  }
});
