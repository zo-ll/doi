import type { EdgeChange, NodeChange } from "@xyflow/react";
import type { Diagram } from "../architecture/schema.ts";
import { sideSchema, type Side } from "../architecture/nodes.ts";
import { removeItems } from "../architecture/edit.ts";
import type { FlowNode, ConnectionPort } from "./components/ArchitectureNode.tsx";
import type { FlowEdge } from "./components/ArchitectureEdge.tsx";
const portId = (id: string, end: "source" | "target") => `${id}-${end}`;
export function portsFor(graph: Diagram, id: string): ConnectionPort[] {
  return [...sideSchema.options.map(side => ({ id: side, side, offset: 0.5, bound: false })),
    ...graph.edges.flatMap(edge => [
      ...(edge.source === id ? [{ id: portId(edge.id, "source"), side: edge.sourceSide, offset: edge.sourceOffset, bound: true }] : []),
      ...(edge.target === id ? [{ id: portId(edge.id, "target"), side: edge.targetSide, offset: edge.targetOffset, bound: true }] : []),
    ])];
}
export function attachment(graph: Diagram, node: string, handle: string | null, fallback: Side): { side: Side; offset: number } {
  const found = portsFor(graph, node).find(port => port.id === handle);
  return { side: found?.side ?? fallback, offset: found?.offset ?? 0.5 };
}
export function flowNodes(graph: Diagram, selected: ReadonlySet<string>): FlowNode[] {
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const depth = (id: string): number => { let n = nodes.get(id), level = 0; while (n?.parent && level < 21) { n = nodes.get(n.parent); level++; } return level; };
  const order = new Map(graph.nodes.map((n, index) => [n.id, index]));
  return graph.nodes.toSorted((a, b) => depth(a.id) - depth(b.id)).map(item => ({
    id: item.id, type: "uml", position: item.position, parentId: item.parent ?? undefined,
    data: { item, ports: portsFor(graph, item.id) }, selected: selected.has(item.id),
    draggable: !item.locked, deletable: !item.locked, ariaLabel: item.name,
    width: item.size.width, height: item.size.height, measured: { ...item.size },
    style: { width: item.size.width, height: item.size.height }, zIndex: (item.shape === "group" ? 0 : 10_000) + (order.get(item.id) ?? 0),
  }));
}
export function flowEdges(graph: Diagram, selected: ReadonlySet<string>): FlowEdge[] {
  return graph.edges.map(item => ({ id: item.id, type: "uml", source: item.source, target: item.target,
    sourceHandle: portId(item.id, "source"), targetHandle: portId(item.id, "target"), data: { item },
    selected: selected.has(item.id), reconnectable: !item.locked, deletable: !item.locked,
    ariaLabel: item.label || "Connector",
  }));
}
export function applyGraphChanges(graph: Diagram, changes: readonly (NodeChange | EdgeChange)[]): Diagram {
  const next = removeItems(graph, new Set(changes.filter(c => c.type === "remove").map(c => c.id)));
  return { ...next, nodes: next.nodes.map(node => {
    if (node.locked) return node;
    let updated = node;
    for (const change of changes) {
      if (!("id" in change) || change.id !== node.id) continue;
      if (change.type === "position" && change.position) updated = { ...updated, position: { x: Math.max(-100000, Math.min(100000, change.position.x)), y: Math.max(-100000, Math.min(100000, change.position.y)) } };
      if (change.type === "dimensions" && change.dimensions && change.setAttributes) updated = { ...updated, size: { width: Math.max(32, Math.min(4096, change.dimensions.width)), height: Math.max(32, Math.min(4096, change.dimensions.height)) } };
    }
    return updated;
  }) };
}
