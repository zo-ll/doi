import { expect, test } from "bun:test";
import { createEdge } from "../src/architecture/edges.ts";
import { edgeRoute } from "../src/web/architecture-routing.ts";
test("connector routes cover straight, elbow, curves, bends and self relations", () => {
  const edge = createEdge("a", "b");
  for (const route of ["straight", "elbow", "curved"] satisfies typeof edge.route[]) {
    const result = edgeRoute({ ...edge, route }, { x: 0, y: 0 }, { x: 300, y: 100 });
    expect(result.path).toStartWith("M");
    expect(result.path).not.toContain("NaN");
  }
  expect(edgeRoute({ ...edge, points: [{ x: 40, y: 70 }] }, { x: 0, y: 0 }, { x: 300, y: 100 }).path).toContain("L 40 70");
  const self = edgeRoute({ ...edge, target: "a" }, { x: 180, y: 45 }, { x: 0, y: 45 });
  expect(self.label.y).toBeLessThan(0);
});
