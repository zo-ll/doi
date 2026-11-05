import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { getSmoothStepPath, Position } from "@xyflow/react";

test("the graph runtime loads under Bun and bundles the actual node component", async () => {
  const [path] = getSmoothStepPath({ sourceX: 0, sourceY: 0, sourcePosition: Position.Right, targetX: 300, targetY: 100, targetPosition: Position.Left });
  expect(path).toStartWith("M");
  expect(path).not.toContain("NaN");
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../src/web/components/ArchitectureNode.tsx", import.meta.url))],
    target: "browser", minify: true,
  });
  expect(result.success).toBe(true);
  expect(result.outputs.length).toBeGreaterThan(0);
  expect((await result.outputs[0]?.text())?.length).toBeGreaterThan(1000);
});
