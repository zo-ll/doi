import { expect, test } from "bun:test";
import { createNode, nodeSchema, shapeSchema } from "../src/architecture/nodes.ts";

test("diagram nodes validate every shape and keep defaults independent", () => {
  for (const shape of shapeSchema.options) {
    const a = createNode(shape, { x: -20, y: 40 });
    const b = createNode(shape, { x: -20, y: 40 });
    expect(nodeSchema.parse(a)).toEqual(a);
    expect(a.id).not.toBe(b.id);
    a.style.fill = "#abcdef";
    a.references.push({ design: "home", page: "index.html", node: null });
    expect(b.style.fill).toBeNull();
    expect(b.references).toEqual([]);
  }
});

test("diagram nodes reject invalid geometry, unknown fields, CSS and unsafe UI references", () => {
  const node = createNode("box", { x: 0, y: 0 });
  for (const change of [
    { position: { x: Infinity, y: 0 } }, { position: { x: 0, y: NaN } },
    { size: { width: -1, height: 90 } }, { shape: "script" }, { unexpected: true },
    { style: { fill: "url(https://example.com)" } },
    { references: [{ design: "home", page: "../secret.html" }] },
    { references: [{ design: "../other", page: "index.html" }] },
  ]) expect(nodeSchema.safeParse({ ...node, ...change }).success).toBe(false);
  expect(nodeSchema.parse({ ...node, references: [{ design: "home", page: "docs/about.html" }] }).references[0]?.page).toBe("docs/about.html");
});
