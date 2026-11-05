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

test("class compartments clip their own text", () => {
  const box = createNode("class", { x: 0, y: 0 }, "Busy");
  box.attributes = Array.from({ length: 12 }, (_, i) => `field${i}: string`).join("\n");
  box.operations = "run()";
  const svg = image(diagramSvg(diagramSchema.parse({ ...createDiagram(), nodes: [box] }), { theme: "dark", background: true })).svg;
  const area = (id: string) => { const m = svg.match(new RegExp(`<clipPath id="${id}"><rect x="[^"]+" y="([^"]+)" width="[^"]+" height="([^"]+)"`)); if (!m) throw new Error(`No ${id}`); return { top: Number(m[1]), bottom: Number(m[1]) + Number(m[2]) }; };
  const attributes = area("c0a"), operations = area("c0o");
  expect(attributes.bottom).toBeLessThanOrEqual(operations.top);
  expect(operations.bottom).toBe(170);
  expect(svg).toContain('<g clip-path="url(#c0a)"><text');
  expect(svg).toContain('<g clip-path="url(#c0o)"><text');
});

test("the view box holds every connector label, also long labels at the outer edges", () => {
  const { graph } = sample();
  const long = "This start label is sixty characters long or a little more";
  const edges = graph.edges.map((e, i) => i === 0 ? { ...e, sourceSide: "left" as const, startLabel: long, points: [{ x: -200, y: 300 }], label: "L".repeat(40) } : e);
  const svg = image(diagramSvg({ ...graph, edges }, { theme: "dark", background: true })).svg;
  const [left, top, width, height] = (svg.match(/viewBox="([^"]+)"/)?.[1] ?? "").split(" ").map(Number);
  const rects = [...svg.matchAll(/<rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="18" rx="3"/g)].map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
  expect(rects.length).toBe(3);
  for (const [x = 0, y = 0, w = 0] of rects) {
    expect(x).toBeGreaterThanOrEqual(left ?? 0);
    expect(y).toBeGreaterThanOrEqual(top ?? 0);
    expect(x + w).toBeLessThanOrEqual((left ?? 0) + (width ?? 0));
    expect(y + 18).toBeLessThanOrEqual((top ?? 0) + (height ?? 0));
  }
});

test("hollow markers stay hollow without a background", () => {
  const { graph } = sample();
  const marker = (svg: string) => svg.match(/<marker [^>]*><path d="M1 0L10 5L1 10Z" fill="([^"]+)"/)?.[1];
  expect(marker(image(diagramSvg(graph, { theme: "dark", background: true })).svg)).toBe("#0e0e0d");
  expect(marker(image(diagramSvg(graph, { theme: "dark", background: false })).svg)).toBe("none");
});

test("control characters are removed and UI links show as on the canvas", () => {
  const box = createNode("box", { x: 0, y: 0 }, "Bad\u0002name\u001f");
  box.references.push({ design: "home", page: "index.html", node: null }, { design: "home", page: "about.html", node: null });
  const svg = image(diagramSvg(diagramSchema.parse({ ...createDiagram(), nodes: [box] }), { theme: "dark", background: true, fontCss: "@font-face{font-family:x}</style><script>" })).svg;
  expect(svg).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  expect(svg).toContain(">Badname<");
  expect(svg).toContain("↗ 2 UI links");
  expect(svg).not.toContain("<script");
});
