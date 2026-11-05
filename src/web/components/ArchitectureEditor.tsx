import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Background, ConnectionMode, Controls, ReactFlow, type Connection, type EdgeChange, type NodeChange, type ReactFlowInstance } from "@xyflow/react";
import { createNode, shapeSchema, type Shape, type uiReferenceSchema } from "../../architecture/nodes.ts";
import type { z } from "zod";
import { createEdge } from "../../architecture/edges.ts";
import { diagramSchema, type Diagram } from "../../architecture/schema.ts";
import { duplicateItems, removeItems } from "../../architecture/edit.ts";
import { diagramFile, MAX_DIAGRAM_FILE_BYTES, readDiagramFile } from "../../architecture/interchange.ts";
import { applyGraphChanges, attachment, flowEdges, flowNodes } from "../architecture-flow.ts";
import { saveBlob } from "../export.ts";
import { ArchitectureNode, type FlowNode } from "./ArchitectureNode.tsx";
import { ArchitectureEdge, type FlowEdge } from "./ArchitectureEdge.tsx";
import { ArchitectureNodeInspector } from "./ArchitectureNodeInspector.tsx";
import { ArchitectureEdgeInspector } from "./ArchitectureEdgeInspector.tsx";
const nodeTypes = { uml: ArchitectureNode }, edgeTypes = { uml: ArchitectureEdge };
type Reference = z.infer<typeof uiReferenceSchema>;
type Document = { graph: Diagram; past: Diagram[]; future: Diagram[] };

export function ArchitectureEditor({ diagram, busy, inspector, tab, designs, onSave, onBack, onDirty, onReload, onReference, onImport }: {
  diagram: Diagram; busy: boolean; inspector: HTMLDivElement | null; tab: "uml" | "comments" | "history"; designs: string[];
  onSave: (graph: Diagram) => Promise<unknown>; onBack: () => void; onDirty: (dirty: boolean) => void; onReload: () => void;
  onReference: (reference: Reference) => void; onImport: (graph: Diagram) => Promise<unknown>;
}) {
  const [doc, setDoc] = useState<Document>({ graph: diagram, past: [], future: [] });
  const [selected, setSelected] = useState(new Set<string>());
  const [flow, setFlow] = useState<ReactFlowInstance<FlowNode, FlowEdge> | null>(null);
  const [grid, setGrid] = useState(true), [snap, setSnap] = useState(true);
  const [comment, setComment] = useState("");
  const [notice, setNotice] = useState<{ kind: "status" | "error"; text: string } | null>(null);
  const clean = useRef(diagram), gesture = useRef<Diagram | null>(null), canvas = useRef<HTMLDivElement>(null);
  const graph = doc.graph;
  const dirty = JSON.stringify(graph) !== JSON.stringify(clean.current);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    if (JSON.stringify(doc.graph) === JSON.stringify(diagram)) { clean.current = diagram; return; }
    if (JSON.stringify(doc.graph) === JSON.stringify(clean.current)) { clean.current = diagram; setDoc({ graph: diagram, past: [], future: [] }); }
  }, [diagram]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function edit(change: (graph: Diagram) => Diagram) {
    setNotice(null);
    setDoc(current => { const next = change(current.graph); return JSON.stringify(next) === JSON.stringify(current.graph) ? current : { graph: next, past: gesture.current ? current.past : [...current.past, current.graph].slice(-80), future: [] }; });
  }
  function beginGesture() { gesture.current = graph; }
  function endGesture() {
    const before = gesture.current; gesture.current = null;
    if (before) setDoc(current => JSON.stringify(current.graph) === JSON.stringify(before) ? current : { ...current, past: [...current.past, before].slice(-80), future: [] });
  }
  function undo(redo = false) {
    setDoc(current => {
      const stack = redo ? current.future : current.past, next = stack.at(-1);
      return !next ? current : redo ? { graph: next, past: [...current.past, current.graph], future: stack.slice(0, -1) } : { graph: next, past: stack.slice(0, -1), future: [...current.future, current.graph] };
    });
  }
  async function save() {
    try { const submitted = graph, snapshot = diagramSchema.parse(submitted); await onSave(snapshot); clean.current = snapshot; setDoc(current => ({ ...current, graph: JSON.stringify(current.graph) === JSON.stringify(submitted) ? snapshot : current.graph })); setNotice({ kind: "status", text: "Saved this version." }); }
    catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) }); }
  }
  function add(shape: Shape) {
    if (graph.nodes.length >= 2000) return;
    const rect = canvas.current?.getBoundingClientRect();
    const position = flow && rect ? flow.screenToFlowPosition({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }) : { x: 80, y: 80 };
    const node = createNode(shape, { x: position.x + (graph.nodes.length % 5) * 24, y: position.y + (graph.nodes.length % 5) * 24 }, `${shape[0]?.toUpperCase()}${shape.slice(1)} ${graph.nodes.length + 1}`);
    edit(g => ({ ...g, nodes: [...g.nodes, node] })); setSelected(new Set([node.id]));
  }
  function connect(connection: Connection, edgeId?: string) {
    if (!graph.nodes.some(n => n.id === connection.source) || !graph.nodes.some(n => n.id === connection.target)) return;
    const source = attachment(graph, connection.source, connection.sourceHandle, "right"), target = attachment(graph, connection.target, connection.targetHandle, "left");
    edit(g => { const original = g.edges.find(e => e.id === edgeId) ?? createEdge(connection.source, connection.target); const next = { ...original, source: connection.source, target: connection.target, sourceSide: source.side, sourceOffset: source.offset, targetSide: target.side, targetOffset: target.offset }; return { ...g, edges: edgeId ? g.edges.map(e => e.id === edgeId ? next : e) : [...g.edges, next] }; });
  }
  function changes(changes: (NodeChange | EdgeChange)[]) {
    setSelected(current => { const next = new Set(current); for (const change of changes) if (change.type === "select") { if (change.selected) next.add(change.id); else next.delete(change.id); } return next; });
    if (changes.some(c => c.type === "position" || c.type === "dimensions" && c.setAttributes || c.type === "remove")) edit(g => applyGraphChanges(g, changes));
  }
  function duplicate() { const result = duplicateItems(graph, selected); edit(() => result.graph); setSelected(result.ids); }
  const nodes = useMemo(() => flowNodes(graph, selected).map(node => ({ ...node, draggable: !busy && node.draggable, data: { ...node.data, onGesture: (active: boolean) => active ? beginGesture() : endGesture() } })), [graph, selected, busy]);
  const edges = useMemo(() => flowEdges(graph, selected), [graph, selected]);
  const pickedNode = selected.size === 1 ? graph.nodes.find(n => selected.has(n.id)) : undefined;
  const pickedEdge = selected.size === 1 ? graph.edges.find(e => selected.has(e.id)) : undefined;
  const selectedNodes = graph.nodes.filter(n => selected.has(n.id));
  return <section className="uml-workspace" aria-label="UML editor" onKeyDown={event => {
    const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
    if (mod && key === "s") { event.preventDefault(); if (!busy) save(); return; }
    const target = event.target;
    if (busy || target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
    if (mod && key === "z") { event.preventDefault(); undo(event.shiftKey); }
    if (mod && key === "d") { event.preventDefault(); event.stopPropagation(); duplicate(); }
    if (key === "delete" || key === "backspace") { event.preventDefault(); edit(g => removeItems(g, selected)); setSelected(new Set()); }
    if (key === "escape") setSelected(new Set());
  }}>
    <header className="uml-canvas-header"><button className="btn btn-ghost" onClick={onBack} disabled={busy}>← Back to UI design</button><strong>{graph.name}</strong><span className="chip">UML</span><span className="uml-save-state" role="status">{busy ? "Save…" : dirty ? "Unsaved changes" : "Saved"}</span><button className="btn btn-primary" disabled={busy || !dirty} onClick={save}>Save diagram</button><button className="btn btn-ghost" disabled={busy} onClick={onReload}>Load latest</button></header>
    <div className="uml-toolbar" aria-label="Diagram tools">
      <details><summary className="btn btn-secondary">+ Shape</summary><div className="uml-shape-menu">{shapeSchema.options.map(shape => <button className="btn" key={shape} disabled={busy || graph.nodes.length >= 2000} onClick={() => add(shape)}>Add {shape}</button>)}</div></details>
      <button className="btn btn-secondary" disabled={busy || selectedNodes.length !== 2 || graph.edges.length >= 4000} onClick={() => { const [a, b] = selectedNodes; if (a && b) connect({ source: a.id, target: b.id, sourceHandle: "right", targetHandle: "left" }); }}>Connect selected</button>
      <button className="btn btn-ghost" onClick={() => undo()} disabled={busy || !doc.past.length}>Undo</button><button className="btn btn-ghost" onClick={() => undo(true)} disabled={busy || !doc.future.length}>Redo</button>
      <button className="btn btn-ghost" onClick={duplicate} disabled={busy || !selectedNodes.length}>Duplicate</button><button className="btn btn-ghost" disabled={busy || !selected.size} onClick={() => { edit(g => removeItems(g, selected)); setSelected(new Set()); }}>Delete selected</button>
      <label className="uml-check"><input type="checkbox" checked={grid} onChange={e => setGrid(e.target.checked)}/>Grid</label><label className="uml-check"><input type="checkbox" checked={snap} onChange={e => setSnap(e.target.checked)}/>Snap</label>
      <button className="btn btn-ghost" onClick={() => { flow?.fitView({ padding: 0.15 }).catch(error => setNotice({ kind: "error", text: String(error) })); }}>Fit all</button>
      <button className="btn btn-secondary" onClick={() => { try { saveBlob(new Blob([diagramFile(graph)], { type: "application/json" }), `${graph.id}.doi-diagram.json`); } catch (error) { setNotice({ kind: "error", text: String(error) }); } }}>Export JSON</button>
      <label className={`btn btn-secondary${busy ? " is-disabled" : ""}`}>Import JSON<input className="visually-hidden" type="file" accept=".json,application/json" disabled={busy} onChange={async event => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; try { if (file.size > MAX_DIAGRAM_FILE_BYTES) throw new Error("The diagram file exceeds 4 MB."); await onImport(readDiagramFile(await file.text())); } catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) }); } }}/></label>
    </div>
    {notice && <p className={`uml-notice${notice.kind === "error" ? " field-error" : ""}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p>}
    <div className="uml-flow" ref={canvas}><ReactFlow<FlowNode, FlowEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={setFlow} onNodesChange={changes} onEdgesChange={changes} onConnect={connection => connect(connection)} onReconnect={(edge, connection) => connect(connection, edge.id)} onNodeDragStart={beginGesture} onNodeDragStop={endGesture} onSelectionDragStart={beginGesture} onSelectionDragStop={endGesture} onPaneClick={() => setSelected(new Set())} connectionMode={ConnectionMode.Loose} selectionOnDrag panOnDrag={[1, 2]} multiSelectionKeyCode={["Control", "Meta", "Shift"]} deleteKeyCode={null} snapToGrid={snap} snapGrid={[16, 16]} defaultViewport={{ x: 40, y: 60, zoom: 1 }} minZoom={0.2} maxZoom={3} colorMode="system">
      {grid && <Background gap={16} size={1}/>}<Controls showInteractive={false}/>
    </ReactFlow></div>
    <footer className="uml-status">{graph.nodes.length} boxes · {graph.edges.length} connectors · {selected.size} selected<span>Drag handles to connect · Shift-click to select several · Space-drag to pan · Ctrl/⌘S to save</span></footer>
    {inspector && createPortal(<fieldset className="uml-inspector" disabled={busy}>
      {tab === "uml" && (pickedNode ? <ArchitectureNodeInspector node={pickedNode} designs={designs} onChange={node => edit(g => ({ ...g, nodes: g.nodes.map(n => n.id === node.id ? node : n) }))} onReference={onReference}/> : pickedEdge ? <ArchitectureEdgeInspector edge={pickedEdge} onChange={edge => edit(g => ({ ...g, edges: g.edges.map(e => e.id === edge.id ? edge : e) }))}/> : <p className="uml-empty">Select a box or connector to edit its properties.</p>)}
      {tab === "comments" && <div className="uml-properties"><h3>Diagram comments</h3>{graph.comments.map(c => <article className="uml-comment" key={c.id}><strong>{c.status === "done" ? "Done" : "Open"} · {c.item}</strong><p>{c.text}</p><button className="btn btn-ghost" onClick={() => edit(g => ({ ...g, comments: g.comments.map(item => item.id === c.id ? { ...item, status: item.status === "open" ? "done" : "open" } : item) }))}>{c.status === "open" ? "Mark done" : "Reopen"}</button></article>)}<label className="field">Comment on the selected item<textarea className="textarea" value={comment} onChange={e => setComment(e.target.value)}/></label><button className="btn btn-secondary" disabled={selected.size !== 1 || !comment.trim()} onClick={() => { const item = [...selected][0]; if (item) { edit(g => ({ ...g, comments: [...g.comments, { id: crypto.randomUUID(), item, text: comment.trim(), status: "open", createdAt: new Date().toISOString() }] })); setComment(""); } }}>Add diagram comment</button></div>}
      {tab === "history" && <div className="uml-properties"><h3>Session history</h3><p>Undo and redo cover this session. Persistent version history is not connected yet.</p>{doc.past.toReversed().map((snapshot, index) => <button key={index} className="btn btn-ghost" onClick={() => edit(() => snapshot)}>Restore session edit {doc.past.length - index} · {snapshot.nodes.length} boxes</button>)}</div>}
    </fieldset>, inspector)}
  </section>;
}
