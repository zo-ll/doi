import { BaseEdge, EdgeText, useViewport, type Edge, type EdgeProps } from "@xyflow/react";
import type { DiagramEdge, Marker } from "../../architecture/edges.ts";
import { edgeRoute } from "../../architecture/routing.ts";
export type FlowEdge = Edge<{ item: DiagramEdge }, "uml">;
const glyphs: Readonly<Partial<Record<Marker, string>>> = {
  arrow: "M1 1L10 5L1 9Z", "open-arrow": "M1 1L10 5L1 9", triangle: "M1 0L10 5L1 10Z",
  diamond: "M0 5L5 1L10 5L5 9Z", "diamond-filled": "M0 5L5 1L10 5L5 9Z",
};
function EndMarker({ id, marker, colour }: { id: string; marker: Marker; colour: string }) {
  const fill = marker === "arrow" || marker === "diamond-filled" ? colour : marker === "open-arrow" ? "none" : "var(--canvas)";
  return <marker id={id} viewBox="0 0 12 10" markerWidth="14" markerHeight="12" refX="10" refY="5" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
    {marker === "circle" ? <circle cx="5" cy="5" r="4" fill={fill} stroke={colour}/> : <path d={glyphs[marker]} fill={fill} stroke={colour} strokeLinejoin="round"/>}
  </marker>;
}
export function ArchitectureEdge({ id, data, sourceX, sourceY, targetX, targetY, selected }: EdgeProps<FlowEdge>) {
  const { zoom } = useViewport();
  if (!data) return null;
  const edge = data.item;
  const source = { x: sourceX, y: sourceY }, target = { x: targetX, y: targetY };
  const { path, label } = edgeRoute(edge, source, target);
  const colour = selected ? "var(--accent)" : edge.colour ?? "var(--text-2)";
  const textStyle = { fill: "var(--text)", fontSize: 12 / Math.min(zoom, 1) };
  const labels = [{ text: edge.label, point: label }, { text: edge.startLabel, point: { x: source.x + 12, y: source.y - 14 } }, { text: edge.endLabel, point: { x: target.x - 12, y: target.y - 14 } }];
  return <>
    <defs>{edge.startMarker !== "none" && <EndMarker id={`uml-${id}-start`} marker={edge.startMarker} colour={colour}/>}{edge.endMarker !== "none" && <EndMarker id={`uml-${id}-end`} marker={edge.endMarker} colour={colour}/>}</defs>
    <BaseEdge id={id} path={path} markerStart={edge.startMarker === "none" ? undefined : `url(#uml-${id}-start)`} markerEnd={edge.endMarker === "none" ? undefined : `url(#uml-${id}-end)`} style={{ stroke: colour, strokeWidth: edge.width, strokeDasharray: edge.line === "dashed" ? "7 4" : edge.line === "dotted" ? "2 4" : undefined }}/>
    {labels.map(({ text, point }, index) => text && <EdgeText key={index} x={point.x} y={point.y} label={text} labelStyle={textStyle} labelBgStyle={{ fill: "var(--panel)" }}/>)}
  </>;
}
