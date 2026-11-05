import { useLayoutEffect } from "react";
import { Handle, NodeResizer, Position, useUpdateNodeInternals, type Node, type NodeProps } from "@xyflow/react";
import type { DiagramNode, Side } from "../../architecture/nodes.ts";
export interface ConnectionPort { id: string; side: Side; offset: number; bound: boolean }
export type FlowNode = Node<{ item: DiagramNode; ports: ConnectionPort[]; onGesture?: (active: boolean) => void; busy?: boolean }, "uml">;
const positions: Readonly<Record<Side, Position>> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };

export function ArchitectureNode({ id, data: { item, ports, onGesture, busy }, selected }: NodeProps<FlowNode>) {
  const updateInternals = useUpdateNodeInternals();
  const portKey = ports.map(port => `${port.id}:${port.side}:${port.offset}`).join("|");
  useLayoutEffect(() => { updateInternals(id); }, [id, portKey, item.size.width, item.size.height, updateInternals]);
  return <>
    <NodeResizer nodeId={id} isVisible={!!selected && !item.locked && !busy} minWidth={32} minHeight={32} maxWidth={4096} maxHeight={4096} color="var(--accent)" onResizeStart={() => onGesture?.(true)} onResizeEnd={() => onGesture?.(false)} />
    <article className={`uml-node uml-node--${item.shape}`} aria-label={item.name} style={{
      background: ["diamond", "actor", "text"].includes(item.shape) ? "transparent" : item.style.fill ?? undefined, borderColor: ["diamond", "actor", "text"].includes(item.shape) ? "transparent" : item.style.stroke ?? undefined,
      color: item.style.text ?? undefined, fontSize: item.style.fontSize, borderStyle: item.style.line,
    }}>
      {item.shape === "diamond" && <svg className="uml-diamond" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M50 1L99 50L50 99L1 50Z" fill={item.style.fill ?? "var(--raised)"} stroke={item.style.stroke ?? "var(--line-2)"} vectorEffect="non-scaling-stroke"/></svg>}
      {item.shape === "actor" && <svg className="uml-actor" viewBox="0 0 60 70" aria-hidden="true"><circle cx="30" cy="10" r="8"/><path d="M30 18V45M12 29H48M30 45L14 66M30 45L46 66"/></svg>}
      {item.stereotype && <span className="uml-stereotype">«{item.stereotype}»</span>}
      <strong>{item.name}</strong>
      {item.content && <span className="uml-content">{item.content}</span>}
      {item.shape === "class" && <><pre>{item.attributes || " "}</pre><pre>{item.operations || " "}</pre></>}
      {item.references.length > 0 && <span className="uml-reference-count">↗ {item.references.length} UI link{item.references.length === 1 ? "" : "s"}</span>}
    </article>
    {ports.map(port => <Handle key={port.id} id={port.id} type="source" position={positions[port.side]} isConnectable={!item.locked && !port.bound && !busy} className={port.bound ? "uml-bound-port" : undefined} style={port.side === "left" || port.side === "right" ? { top: `${port.offset * 100}%` } : { left: `${port.offset * 100}%` }} aria-label={`Connect ${port.side} of ${item.name}`} />)}
  </>;
}
