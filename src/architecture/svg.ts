import type { DiagramEdge, Marker } from "./edges.ts";
import type { DiagramNode, Point, Side } from "./nodes.ts";
import { edgeRoute } from "./routing.ts";
import type { Diagram } from "./schema.ts";

/**
 * A standalone SVG of a diagram, or of a selection in it, for SVG/PNG/PDF export and agent renders.
 * Pure: it runs in the browser and on the server. Colours follow doi's dark and light themes;
 * the oklch theme colours are hex approximations, so other SVG tools show them too.
 */
export type ExportTheme = "dark" | "light";
export interface SvgOptions {
  theme: ExportTheme;
  /** False: a transparent background (SVG and PNG). */
  background: boolean;
  /** Only these boxes (with the boxes inside them) and connectors. Absent: the whole diagram. */
  ids?: ReadonlySet<string>;
  /** `@font-face` rules to embed (the server adds IBM Plex as data URLs). */
  fontCss?: string;
}
export interface DiagramImage { svg: string; width: number; height: number }

const PALETTES = {
  dark: { canvas: "#0e0e0d", panel: "#1a1a18", raised: "#222220", line: "#2a2926", line2: "#3b3a36", text: "#eceae4", text2: "#b4b0a7", warn: "#e3b04b", warnSoft: "#3b3020" },
  light: { canvas: "#e8e6e1", panel: "#faf9f6", raised: "#ffffff", line: "#e1ded7", line2: "#cdc9c0", text: "#1d1c19", text2: "#53504a", warn: "#b8771a", warnSoft: "#f8eedb" },
} as const;
type Palette = typeof PALETTES[ExportTheme];
const FONT = "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace";
const PAD = 32, MAX_WALK = 21;

/** XML text: the five special characters as entities; C0 controls other than TAB, LF and CR, U+FFFE and U+FFFF are invalid XML 1.0 and go. */
const escape = (text: string) => text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
const num = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(2);
type Rect = { x: number; y: number; width: number; height: number };

/** Lines that fit `width` at `size`, about 0.56 em for each character. Long words break, except with `breakWords` false (the class compartments keep them, as the canvas does). */
export function wrap(text: string, width: number, size: number, mono = false, breakWords = true): string[] {
  const per = Math.max(1, Math.floor(width / (size * (mono ? 0.62 : 0.56))));
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      if ((line + word).length <= per) { line += word; continue; }
      if (line.trim()) out.push(line.trimEnd());
      let rest = word.trimStart();
      while (breakWords && rest.length > per) { out.push(rest.slice(0, per)); rest = rest.slice(per); }
      line = rest;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** The nodes in scope: the chosen boxes and every box inside a chosen group. */
function scope(graph: Diagram, ids: ReadonlySet<string> | undefined): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  if (!ids) return { nodes: graph.nodes, edges: graph.edges };
  const included = new Set(graph.nodes.filter(n => ids.has(n.id)).map(n => n.id));
  for (let depth = 0; depth < MAX_WALK; depth++) {
    const before = included.size;
    for (const node of graph.nodes) if (node.parent && included.has(node.parent)) included.add(node.id);
    if (before === included.size) break;
  }
  return { nodes: graph.nodes.filter(n => included.has(n.id)), edges: graph.edges.filter(e => included.has(e.source) && included.has(e.target)) };
}

function absoluteRects(graph: Diagram): Map<string, Rect> {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const out = new Map<string, Rect>();
  const resolve = (node: DiagramNode, depth: number): Rect => {
    const known = out.get(node.id);
    if (known) return known;
    const parent = node.parent ? byId.get(node.parent) : undefined;
    const origin = parent && depth <= MAX_WALK ? resolve(parent, depth + 1) : { x: 0, y: 0 };
    const rect = { x: origin.x + node.position.x, y: origin.y + node.position.y, ...node.size };
    out.set(node.id, rect);
    return rect;
  };
  for (const node of graph.nodes) resolve(node, 0);
  return out;
}
function depthOf(graph: Diagram, node: DiagramNode): number {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  let depth = 0, parent = node.parent;
  while (parent && depth <= MAX_WALK) { depth++; parent = byId.get(parent)?.parent ?? null; }
  return depth;
}
function anchor(rect: Rect, side: Side, offset: number): Point {
  if (side === "top") return { x: rect.x + rect.width * offset, y: rect.y };
  if (side === "bottom") return { x: rect.x + rect.width * offset, y: rect.y + rect.height };
  if (side === "left") return { x: rect.x, y: rect.y + rect.height * offset };
  return { x: rect.x + rect.width, y: rect.y + rect.height * offset };
}

function textLines(lines: string[], x: number, y: number, size: number, options: { colour: string; weight?: number; anchor?: "start" | "middle"; mono?: boolean }): string {
  const lineHeight = Math.round(size * 1.35);
  return lines.map((line, i) => `<text x="${num(x)}" y="${num(y + i * lineHeight)}" font-size="${size}" font-family="${escape(options.mono ? MONO : FONT)}"${options.weight ? ` font-weight="${options.weight}"` : ""} fill="${escape(options.colour)}"${options.anchor === "middle" ? ' text-anchor="middle"' : ""} dominant-baseline="hanging" xml:space="preserve">${escape(line)}</text>`).join("");
}

/** The canvas line for a box with UI references. */
const links = (node: DiagramNode) => `↗ ${node.references.length} UI link${node.references.length === 1 ? "" : "s"}`;
/** One box. `defs` receives its clip paths: the box, and the two class compartments. */
function nodeSvg(node: DiagramNode, rect: Rect, palette: Palette, clip: string, defs: string[]): string {
  const { x, y, width, height } = rect;
  const size = node.style.fontSize, lineHeight = Math.round(size * 1.35);
  const note = node.shape === "note";
  const fill = node.style.fill ?? (note ? palette.warnSoft : node.shape === "group" ? palette.panel : palette.raised);
  const stroke = node.style.stroke ?? (note ? palette.warn : palette.line2);
  const text = node.style.text ?? palette.text;
  const dash = node.shape === "group" ? ' stroke-dasharray="6 4"' : node.style.line === "dashed" ? ' stroke-dasharray="7 4"' : node.style.line === "dotted" ? ' stroke-dasharray="2 4"' : "";
  let body = "";
  if (node.shape === "box" || node.shape === "rounded" || node.shape === "class") {
    body += `<rect x="${num(x + 0.5)}" y="${num(y + 0.5)}" width="${num(width - 1)}" height="${num(height - 1)}" rx="${node.shape === "rounded" ? 18 : 4}" fill="${escape(fill)}" stroke="${escape(stroke)}"${dash}/>`;
  } else if (node.shape === "ellipse") {
    body += `<ellipse cx="${num(x + width / 2)}" cy="${num(y + height / 2)}" rx="${num(width / 2 - 0.5)}" ry="${num(height / 2 - 0.5)}" fill="${escape(fill)}" stroke="${escape(stroke)}"${dash}/>`;
  } else if (node.shape === "diamond") {
    body += `<path d="M${num(x + width / 2)} ${num(y + 1)}L${num(x + width - 1)} ${num(y + height / 2)}L${num(x + width / 2)} ${num(y + height - 1)}L${num(x + 1)} ${num(y + height / 2)}Z" fill="${escape(fill)}" stroke="${escape(stroke)}"${dash}/>`;
  } else if (note) {
    body += `<rect x="${num(x + 0.5)}" y="${num(y + 0.5)}" width="${num(width - 1)}" height="${num(height - 1)}" rx="3" fill="${escape(fill)}" stroke="${escape(stroke)}"${dash}/>`;
  } else if (node.shape === "group") {
    body += `<rect x="${num(x + 0.5)}" y="${num(y + 0.5)}" width="${num(width - 1)}" height="${num(height - 1)}" rx="4" fill="${escape(fill)}" fill-opacity="${node.style.fill ? 1 : 0.2}" stroke="${escape(stroke)}"${dash}/>`;
  }
  const inner = width - 24;
  if (node.shape === "class") {
    let cursor = y + 8;
    const head: string[] = [];
    if (node.stereotype) { head.push(textLines([`«${node.stereotype}»`], x + width / 2, cursor, Math.max(10, size - 2), { colour: palette.text2, anchor: "middle" })); cursor += lineHeight; }
    const title = wrap(node.name, inner, size).slice(0, 2);
    head.push(textLines(title, x + width / 2, cursor, size, { colour: text, weight: 600, anchor: "middle" }));
    cursor += title.length * lineHeight + 8;
    const attributes = wrap(node.attributes, inner, size, true, false), operations = wrap(node.operations, inner, size, true, false);
    // The canvas gives the two compartments equal shares of the rest; a UI-link row takes the bottom.
    const bottom = node.references.length ? y + height - Math.round(Math.max(10, size - 2) * 1.35) - 8 : y + height;
    const split = cursor + Math.round((bottom - cursor) / 2);
    body += head.join("");
    body += `<path d="M${num(x)} ${num(cursor)}H${num(x + width)}M${num(x)} ${num(split)}H${num(x + width)}" stroke="${palette.line}"/>`;
    // Each compartment clips its own text, as the canvas scrolls each one.
    defs.push(`<clipPath id="${clip}a"><rect x="${num(x)}" y="${num(cursor)}" width="${num(width)}" height="${num(Math.max(0, split - cursor))}"/></clipPath>`);
    defs.push(`<clipPath id="${clip}o"><rect x="${num(x)}" y="${num(split)}" width="${num(width)}" height="${num(Math.max(0, bottom - split))}"/></clipPath>`);
    body += `<g clip-path="url(#${clip}a)">${textLines(attributes, x + 12, cursor + 8, size, { colour: text, mono: true })}</g>`;
    body += `<g clip-path="url(#${clip}o)">${textLines(operations, x + 12, split + 8, size, { colour: text, mono: true })}</g>`;
    if (node.references.length) body += textLines([links(node)], x + 12, bottom + 4, Math.max(10, size - 2), { colour: palette.text2 });
  } else if (node.shape === "actor") {
    // The canvas icon: 48 × 58 px in the text colour, above the name, both centred.
    const cx = x + width / 2, name = wrap(node.name, width, size).slice(0, 2);
    const top = y + Math.max(0, (height - 58 - 4 - name.length * lineHeight) / 2);
    body += `<g transform="translate(${num(cx - 24)} ${num(top)}) scale(0.8 ${num(58 / 70)})" fill="none" stroke="${escape(text)}" stroke-width="1.5" vector-effect="non-scaling-stroke"><circle cx="30" cy="10" r="8"/><path d="M30 18V45M12 29H48M30 45L14 66M30 45L46 66"/></g>`;
    body += textLines(name, cx, top + 62, size, { colour: text, weight: 600, anchor: "middle" });
    if (node.references.length) body += textLines([links(node)], cx, top + 62 + name.length * lineHeight + 4, Math.max(10, size - 2), { colour: palette.text2, anchor: "middle" });
  } else if (node.shape === "group") {
    body += textLines(wrap(node.name, inner, Math.max(10, size - 2)).slice(0, 1), x + 12, y + 8, Math.max(10, size - 2), { colour: palette.text2, weight: 600 });
    if (node.references.length) body += textLines([links(node)], x + 12, y + 8 + lineHeight + 4, Math.max(10, size - 2), { colour: palette.text2 });
  } else {
    const centred = node.shape === "ellipse" || node.shape === "diamond";
    const box = centred ? width - 32 : node.shape === "text" ? width : inner;
    const lines: [string[], { colour: string; weight?: number; small?: boolean }][] = [];
    if (node.stereotype) lines.push([[`«${node.stereotype}»`], { colour: palette.text2, small: true }]);
    lines.push([wrap(node.name, box, size), { colour: text, weight: 600 }]);
    if (node.content) lines.push([wrap(node.content, box, size), { colour: node.style.text ?? palette.text2 }]);
    if (node.references.length) lines.push([[links(node)], { colour: palette.text2, small: true }]);
    const total = lines.reduce((sum, [l]) => sum + l.length * lineHeight, 0) + (lines.length - 1) * 4;
    let cursor = note ? y + 10 : y + Math.max(8, (height - total) / 2);
    const tx = centred ? x + width / 2 : node.shape === "text" ? x : x + 12;
    for (const [part, style] of lines) {
      body += textLines(part, tx, cursor, style.small ? Math.max(10, size - 2) : size, { colour: style.colour, weight: style.weight, anchor: centred ? "middle" : "start" });
      cursor += part.length * lineHeight + 4;
    }
  }
  return `<g data-id="${escape(node.id)}" clip-path="url(#${clip})">${body}</g>`;
}

const GLYPHS: Readonly<Partial<Record<Marker, string>>> = {
  arrow: "M1 1L10 5L1 9Z", "open-arrow": "M1 1L10 5L1 9", triangle: "M1 0L10 5L1 10Z",
  diamond: "M0 5L5 1L10 5L5 9Z", "diamond-filled": "M0 5L5 1L10 5L5 9Z",
};
/** `background`: the fill inside a hollow marker; null in a transparent export, so the marker stays hollow. */
function markerSvg(id: string, marker: Marker, colour: string, background: string | null): string {
  const fill = marker === "arrow" || marker === "diamond-filled" ? colour : marker === "open-arrow" ? "none" : background ?? "none";
  const shape = marker === "circle" ? `<circle cx="5" cy="5" r="4" fill="${escape(fill)}" stroke="${escape(colour)}"/>` : `<path d="${GLYPHS[marker] ?? ""}" fill="${escape(fill)}" stroke="${escape(colour)}" stroke-linejoin="round"/>`;
  return `<marker id="${id}" viewBox="0 0 12 10" markerWidth="14" markerHeight="12" refX="10" refY="5" orient="auto-start-reverse" markerUnits="userSpaceOnUse">${shape}</marker>`;
}
/** A generous width of 12 px IBM Plex Sans text: wide letters and CJK count more than narrow ones. */
export function labelWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += code >= 0x2e80 ? 12.5 : /[MWmwШЩЖЮШмшщжюΩΣ@%]/u.test(char) ? 12 : /[\p{Lu}\p{Nd}#&]/u.test(char) ? 8.5 : /[ilj.,:;'|!()\[\] ]/.test(char) ? 4 : 7;
  }
  return Math.ceil(width);
}
/** The chip around a connector label. */
const labelBox = (text: string, at: Point): Rect => { const width = labelWidth(text) + 10; return { x: at.x - width / 2, y: at.y - 9, width, height: 18 }; };
function labelSvg(text: string, at: Point, palette: Palette): string {
  const { width, height } = labelBox(text, at);
  return `<rect x="${num(at.x - width / 2)}" y="${num(at.y - height / 2)}" width="${num(width)}" height="${height}" rx="3" fill="${palette.panel}"/><text x="${num(at.x)}" y="${num(at.y)}" font-size="12" font-family="${escape(FONT)}" fill="${palette.text}" text-anchor="middle" dominant-baseline="central">${escape(text)}</text>`;
}

/** The text that an image of `graph` draws: the font subsets follow it, not comments or ids. */
export function imageText(graph: Diagram, ids?: ReadonlySet<string>): string {
  const { nodes, edges } = scope(graph, ids);
  return [graph.name, ...nodes.flatMap(n => [n.name, n.stereotype, n.content, n.attributes, n.operations]), ...edges.flatMap(e => [e.label, e.startLabel, e.endLabel])].join("\n");
}

export function diagramSvg(graph: Diagram, options: SvgOptions): DiagramImage | { error: string } {
  const palette = PALETTES[options.theme];
  const { nodes, edges } = scope(graph, options.ids);
  if (!nodes.length) return { error: options.ids ? "Select one or more boxes to export." : "The diagram is empty." };
  const rects = absoluteRects(graph);
  const routes = edges.flatMap(edge => {
    const from = rects.get(edge.source), to = rects.get(edge.target);
    if (!from || !to) return [];
    const source = anchor(from, edge.sourceSide, edge.sourceOffset), target = anchor(to, edge.targetSide, edge.targetOffset);
    const route = edgeRoute(edge, source, target);
    const labels = [[edge.label, route.label], [edge.startLabel, { x: source.x + 12, y: source.y - 14 }], [edge.endLabel, { x: target.x - 12, y: target.y - 14 }]] as const;
    return [{ edge, source, target, labels, ...route }];
  });
  // Bounds: boxes, bend points, label positions and the self-connector loop.
  const xs: number[] = [], ys: number[] = [];
  for (const node of nodes) { const r = rects.get(node.id); if (r) { xs.push(r.x, r.x + r.width); ys.push(r.y, r.y + r.height); } }
  for (const { edge, source, target, label, labels } of routes) {
    for (const p of [source, target, label, ...edge.points]) { xs.push(p.x - 16, p.x + 16); ys.push(p.y - 16, p.y + 16); }
    for (const [text, at] of labels) if (text) { const box = labelBox(text, at); xs.push(box.x, box.x + box.width); ys.push(box.y, box.y + box.height); }
    if (edge.source === edge.target) ys.push(Math.min(source.y, target.y) - 90);
  }
  const left = Math.floor(Math.min(...xs) - PAD), top = Math.floor(Math.min(...ys) - PAD);
  const width = Math.ceil(Math.max(...xs) + PAD - left), height = Math.ceil(Math.max(...ys) + PAD - top);

  const defs: string[] = [], markers = new Map<string, string>();
  const markerId = (marker: Marker, colour: string) => {
    const key = `${marker}|${colour}`;
    let id = markers.get(key);
    if (!id) { id = `m${markers.size}`; markers.set(key, id); defs.push(markerSvg(id, marker, colour, options.background ? palette.canvas : null)); }
    return id;
  };
  const order = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const drawn = nodes.toSorted((a, b) => {
    const layer = (n: DiagramNode) => n.shape === "group" ? 0 : 1;
    return layer(a) - layer(b) || (a.shape === "group" && b.shape === "group" ? depthOf(graph, a) - depthOf(graph, b) : 0) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });
  const shapes = drawn.map((node, i) => {
    const r = rects.get(node.id);
    if (!r) return "";
    defs.push(`<clipPath id="c${i}"><rect x="${num(r.x - 1)}" y="${num(r.y - 1)}" width="${num(r.width + 2)}" height="${num(r.height + 2)}"/></clipPath>`);
    return nodeSvg(node, r, palette, `c${i}`, defs);
  });
  const groups = shapes.filter((_, i) => drawn[i]?.shape === "group"), boxes = shapes.filter((_, i) => drawn[i]?.shape !== "group");
  const hollow = (marker: Marker) => marker === "triangle" || marker === "diamond" || marker === "circle";
  /** The unit vector from a connector end out along its line: the side's normal, or toward the nearest bend point. */
  const outward = (at: Point, side: Side, toward: Point | undefined, self?: "start" | "end"): Point => {
    // A self connector leaves to the right and comes back from the left (`edgeRoute`), whatever its sides.
    if (self && !toward) return { x: self === "start" ? 1 : -1, y: 0 };
    if (toward) { const dx = toward.x - at.x, dy = toward.y - at.y, length = Math.hypot(dx, dy) || 1; return { x: dx / length, y: dy / length }; }
    return side === "left" ? { x: -1, y: 0 } : side === "right" ? { x: 1, y: 0 } : side === "top" ? { x: 0, y: -1 } : { x: 0, y: 1 };
  };
  const lines = routes.map(({ edge, path, labels, source, target }, index) => {
    const colour = edge.colour ?? palette.text2;
    const dash = edge.line === "dashed" ? ' stroke-dasharray="7 4"' : edge.line === "dotted" ? ' stroke-dasharray="2 4"' : "";
    const start = edge.startMarker === "none" ? "" : ` marker-start="url(#${markerId(edge.startMarker, colour)})"`;
    const end = edge.endMarker === "none" ? "" : ` marker-end="url(#${markerId(edge.endMarker, colour)})"`;
    const text = labels.map(([label, at]) => label ? labelSvg(label, at, palette) : "").join("");
    const line = `fill="none" stroke="${escape(colour)}" stroke-width="${num(edge.width)}"${dash}`;
    // Without a background, a hollow marker shows what is behind it: a mask hides the line under it.
    const holes = options.background ? [] : [
      ...(hollow(edge.startMarker) ? [[source, outward(source, edge.sourceSide, edge.points[0], edge.source === edge.target ? "start" : undefined)] as const] : []),
      ...(hollow(edge.endMarker) ? [[target, outward(target, edge.targetSide, edge.points.at(-1), edge.source === edge.target ? "end" : undefined)] as const] : []),
    ];
    if (!holes.length) return `<g data-id="${escape(edge.id)}"><path d="${escape(path)}" ${line}${start}${end}/>${text}</g>`;
    defs.push(`<mask id="k${index}" maskUnits="userSpaceOnUse" x="${left}" y="${top}" width="${width}" height="${height}"><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="#fff"/>${holes.map(([tip, n]) => `<circle cx="${num(tip.x + n.x * 6)}" cy="${num(tip.y + n.y * 6)}" r="6" fill="#000"/>`).join("")}</mask>`);
    return `<g data-id="${escape(edge.id)}"><path d="${escape(path)}" ${line} mask="url(#k${index})"/><path d="${escape(path)}" fill="none" stroke="none"${start}${end}/>${text}</g>`;
  });
  const background = options.background ? `<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="${palette.canvas}"/>` : "";
  const title = `<title>${escape(graph.name)}</title>`;
  // CSS needs no "<": removing it keeps the rules from closing the style element.
  const fonts = options.fontCss ? `<style>${options.fontCss.replace(/</g, "")}</style>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${left} ${top} ${width} ${height}" role="img">${title}<defs>${fonts}${defs.join("")}</defs>${background}${groups.join("")}${lines.join("")}${boxes.join("")}</svg>`;
  return { svg, width, height };
}
