import { expect, test } from "bun:test";
import { createDiagram, diagramSchema, type Diagram } from "../src/architecture/schema.ts";
import { createNode, type DiagramNode } from "../src/architecture/nodes.ts";
import { applyRelationship, createEdge } from "../src/architecture/edges.ts";
import { groupItems } from "../src/architecture/layout.ts";
import { diagramSvg, wrap, type DiagramImage } from "../src/architecture/svg.ts";

function sample(): { graph: Diagram; web: DiagramNode; api: DiagramNode; db: DiagramNode } {
  const web = createNode("box", { x: 0, y: 0 }, "Web app");
  const api = createNode("class", { x: 400, y: 0 }, "API service");
  api.stereotype = "service"; api.attributes = "endpoint: URL"; api.operations = "saveNote()";
  const db = createNode("ellipse", { x: 400, y: 400 }, "Database");
  const uses = { ...applyRelationship(createEdge(web.id, api.id), "inheritance"), label: "uses API", startLabel: "1", endLabel: "0..*" };
  const stores = { ...createEdge(api.id, db.id), line: "dashed" as const, endMarker: "diamond-filled" as const };
  return { graph: diagramSchema.parse({ ...createDiagram(), nodes: [web, api, db], edges: [uses, stores] }), web, api, db };
}
const image = (result: DiagramImage | { error: string }) => { if ("error" in result) throw new Error(result.error); return result; };

test("the whole diagram has every box, label, marker and the theme background", () => {
  const { graph } = sample();
  const { svg, width, height } = image(diagramSvg(graph, { theme: "dark", background: true }));
  for (const text of ["Web app", "API service", "«service»", "endpoint: URL", "saveNote()", "Database", "uses API", ">1<", "0..*"]) expect(svg).toContain(text);
  expect(svg.match(/<marker /g)).toHaveLength(2);
  expect(svg).toContain('stroke-dasharray="7 4"');
  expect(svg).toContain('fill="#0e0e0d"');
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  // 0..580 wide boxes and 0..490 high, plus padding and label room.
  expect(width).toBeGreaterThan(580);
  expect(height).toBeGreaterThan(490);
  expect(svg).toContain(`width="${width}" height="${height}"`);
});

test("light theme and a transparent background change only the colours", () => {
  const { graph } = sample();
  const light = image(diagramSvg(graph, { theme: "light", background: false })).svg;
  expect(light).not.toContain("#0e0e0d");
  expect(light).not.toContain('fill="#e8e6e1"/>');
  expect(light).toContain("#ffffff");
});

test("a selection exports its boxes, the boxes inside a selected group and the connectors between them", () => {
  const { graph, web, api, db } = sample();
  const only = image(diagramSvg(graph, { theme: "dark", background: true, ids: new Set([web.id, api.id]) })).svg;
  expect(only).toContain("Web app");
  expect(only).not.toContain("Database");
  expect(only).toContain("uses API");
  expect(only.match(/<path d="M[^"]*" fill="none"/g)?.length).toBe(1);
  const grouped = groupItems(graph, new Set([api.id, db.id]));
  if ("error" in grouped) throw new Error(grouped.error);
  const group = image(diagramSvg(grouped.graph, { theme: "dark", background: true, ids: new Set([grouped.group]) })).svg;
  expect(group).toContain("API service");
  expect(group).toContain("Database");
  expect(group).not.toContain("Web app");
  expect(diagramSvg(graph, { theme: "dark", background: true, ids: new Set() })).toEqual({ error: "Select one or more boxes to export." });
  expect(diagramSvg({ ...graph, nodes: [], edges: [] }, { theme: "dark", background: true })).toEqual({ error: "The diagram is empty." });
});

test("text is escaped and colours come only from validated values", () => {
  const box = createNode("note", { x: 0, y: 0 }, `<script>alert("x")</script> & 'q'`);
  box.content = "]]></svg><svg onload=alert(1)>";
  box.style.fill = "#123456";
  box.size = { width: 1200, height: 200 };
  const svg = image(diagramSvg(diagramSchema.parse({ ...createDiagram(), name: "<b>Name</b>", nodes: [box] }), { theme: "light", background: true })).svg;
  expect(svg).not.toContain("<script");
  expect(svg).not.toContain("<b>");
  expect(svg).not.toContain("<svg onload");
  expect(svg).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;");
  expect(svg).toContain('fill="#123456"');
});

test("wrap breaks lines at the box width and splits long words", () => {
  expect(wrap("one two three four", 60, 10)).toEqual(["one two", "three four"]);
  expect(wrap("a\nb", 100, 10)).toEqual(["a", "b"]);
  expect(wrap("x".repeat(25), 57, 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
});
