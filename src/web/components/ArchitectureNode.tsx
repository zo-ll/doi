import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import type { DiagramNode, Side } from "../../architecture/nodes.ts";
export type FlowNode = Node<{ item: DiagramNode }, "uml">;
const positions: Readonly<Record<Side, Position>> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };

export function ArchitectureNode({ id, data: { item }, selected }: NodeProps<FlowNode>) {
  return <>
    <NodeResizer nodeId={id} isVisible={!!selected && !item.locked} minWidth={32} minHeight={32} maxWidth={4096} maxHeight={4096} color="var(--accent)" />
    <article className={`uml-node uml-node--${item.shape}`} aria-label={item.name} style={{
      background: item.style.fill ?? undefined, borderColor: item.style.stroke ?? undefined,
      color: item.style.text ?? undefined, fontSize: item.style.fontSize, borderStyle: item.style.line,
    }}>
      {item.shape === "actor" && <svg className="uml-actor" viewBox="0 0 60 70" aria-hidden="true"><circle cx="30" cy="10" r="8"/><path d="M30 18V45M12 29H48M30 45L14 66M30 45L46 66"/></svg>}
      {item.stereotype && <span className="uml-stereotype">«{item.stereotype}»</span>}
      <strong>{item.name}</strong>
      {item.content && <span className="uml-content">{item.content}</span>}
      {item.shape === "class" && <><pre>{item.attributes || " "}</pre><pre>{item.operations || " "}</pre></>}
      {item.references.length > 0 && <span className="uml-reference-count">↗ {item.references.length} UI link{item.references.length === 1 ? "" : "s"}</span>}
    </article>
    {item.shape !== "group" && Object.entries(positions).map(([side, position]) =>
      <Handle key={side} id={side} type="source" position={position} isConnectable={!item.locked} aria-label={`Connect ${side} of ${item.name}`} />)}
  </>;
}
