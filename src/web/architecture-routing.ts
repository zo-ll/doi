import { getBezierPath, getSmoothStepPath, getStraightPath, Position } from "@xyflow/react";
import type { DiagramEdge } from "../architecture/edges.ts";
import type { Point, Side } from "../architecture/nodes.ts";
const positions: Readonly<Record<Side, Position>> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };

export function edgeRoute(edge: DiagramEdge, source: Point, target: Point): { path: string; label: Point } {
  if (edge.points.length) {
    return { path: `M ${source.x} ${source.y} ${[...edge.points, target].map(p => `L ${p.x} ${p.y}`).join(" ")}`, label: edge.points[Math.floor(edge.points.length / 2)] ?? source };
  }
  if (edge.source === edge.target) {
    const left = Math.min(source.x, target.x) - 40, right = Math.max(source.x, target.x) + 40, top = Math.min(source.y, target.y) - 80;
    return { path: `M ${source.x} ${source.y} H ${right} V ${top} H ${left} V ${target.y} H ${target.x}`, label: { x: (left + right) / 2, y: top } };
  }
  const args = { sourceX: source.x, sourceY: source.y, targetX: target.x, targetY: target.y, sourcePosition: positions[edge.sourceSide], targetPosition: positions[edge.targetSide] };
  const [path, x, y] = edge.route === "curved" ? getBezierPath(args) : edge.route === "straight" ? getStraightPath(args) : getSmoothStepPath(args);
  return { path, label: { x, y } };
}
