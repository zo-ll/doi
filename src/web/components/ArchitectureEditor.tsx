import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Background, ConnectionMode, Controls, ReactFlow, ViewportPortal, type Connection, type EdgeChange, type NodeChange, type ReactFlowInstance } from "@xyflow/react";
import { createNode, shapeSchema, type Shape, type uiReferenceSchema } from "../../architecture/nodes.ts";
import type { z } from "zod";
import { createEdge } from "../../architecture/edges.ts";
import { diagramSchema, type Diagram } from "../../architecture/schema.ts";
import { architectureErrorMessage } from "../../architecture/errors.ts";
import { duplicateItems, removeItems } from "../../architecture/edit.ts";
import { absolutePosition, alignItems, copyItems, distributeItems, groupItems, movableNodes, nudgeItems, pasteItems, readClipboard, reorderItems, snapToGuides, ungroupItems, type AlignMode, type Clipboard, type Guide, type OrderMode } from "../../architecture/layout.ts";
import { diagramFile, MAX_DIAGRAM_FILE_BYTES, readDiagramFile } from "../../architecture/interchange.ts";
import { applyGraphChanges, attachment, flowEdges, flowNodes } from "../architecture-flow.ts";
import { saveBlob } from "../export.ts";
import { architectureCheckpoint, ArchitectureRequestError } from "../architecture.ts";
import { ArchitectureHistory } from "./ArchitectureHistory.tsx";
import { ArchitectureNode, type FlowNode } from "./ArchitectureNode.tsx";
import { ArchitectureEdge, type FlowEdge } from "./ArchitectureEdge.tsx";
import { ArchitectureNodeInspector } from "./ArchitectureNodeInspector.tsx";
import { ArchitectureEdgeInspector } from "./ArchitectureEdgeInspector.tsx";
const nodeTypes = { uml: ArchitectureNode }, edgeTypes = { uml: ArchitectureEdge };
type Reference = z.infer<typeof uiReferenceSchema>;
type Document = { graph: Diagram; past: Diagram[]; future: Diagram[] };
/** Autosave waits for a pause in the edits. A version is recorded at most this often during autosave. */
const AUTOSAVE_MS = 1000, CHECKPOINT_MS = 5 * 60 * 1000;
type Pause = null | "conflict" | "invalid" | "failed";

export function ArchitectureEditor({ project, diagram, busy, inspector, tab, designs, onSave, onBack, onDirty, onReload, onReference, onImport }: {
  project: string; diagram: Diagram; busy: boolean; inspector: HTMLDivElement | null; tab: "uml" | "comments" | "history"; designs: string[];
  onSave: (graph: Diagram) => Promise<unknown>; onBack: (saved: boolean) => void; onDirty: (dirty: boolean) => void; onReload: () => void;
  onReference: (reference: Reference) => void; onImport: (graph: Diagram) => Promise<unknown>;
}) {
  const [doc, setDoc] = useState<Document>({ graph: diagram, past: [], future: [] });
  const [selected, setSelected] = useState(new Set<string>());
  const [flow, setFlow] = useState<ReactFlowInstance<FlowNode, FlowEdge> | null>(null);
  const [grid, setGrid] = useState(true), [snap, setSnap] = useState(true);
  const [comment, setComment] = useState("");
  const [notice, setNotice] = useState<{ kind: "status" | "error"; text: string } | null>(null);
  const [guides, setGuides] = useState<{ origin: { x: number; y: number }; lines: Guide[] }>({ origin: { x: 0, y: 0 }, lines: [] });
  const clean = useRef(diagram), gesture = useRef<Diagram | null>(null), canvas = useRef<HTMLDivElement>(null), section = useRef<HTMLElement>(null);
  const clipboard = useRef<{ clip: Clipboard; pastes: number } | null>(null);
  const [pause, setPause] = useState<Pause>(null), [gesturing, setGesturing] = useState(false), [versions, setVersions] = useState(0);
  const unrecorded = useRef(false), recorded = useRef(Date.now()), inflight = useRef<Promise<boolean> | null>(null);
  const graph = doc.graph;
  const dirty = JSON.stringify(graph) !== JSON.stringify(clean.current);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    if (JSON.stringify(doc.graph) === JSON.stringify(diagram)) { clean.current = diagram; return; }
    if (JSON.stringify(doc.graph) === JSON.stringify(clean.current)) { clean.current = diagram; setDoc(current => ({ ...current, graph: diagram })); }
  }, [diagram]);
  useEffect(() => {
    const close = (event: PointerEvent) => { for (const menu of document.querySelectorAll<HTMLDetailsElement>(".uml-toolbar details[open]")) if (!(event.target instanceof Node && menu.contains(event.target))) menu.open = false; };
    document.addEventListener("pointerdown", close, true); return () => document.removeEventListener("pointerdown", close, true);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  /** A new edit retries a save that failed for its values or the network; a conflict needs Load latest. */
  const resume = () => setPause(current => current === "conflict" ? current : null);
  function edit(change: (graph: Diagram) => Diagram) {
    setNotice(null); resume();
    setDoc(current => { const next = change(current.graph); return JSON.stringify(next) === JSON.stringify(current.graph) ? current : { graph: next, past: gesture.current ? current.past : [...current.past, current.graph].slice(-80), future: [] }; });
  }
  function beginGesture() { gesture.current = graph; setGesturing(true); }
  function endGesture() {
    const before = gesture.current; gesture.current = null; setGesturing(false);
    if (before) setDoc(current => JSON.stringify(current.graph) === JSON.stringify(before) ? current : { ...current, past: [...current.past, before].slice(-80), future: [] });
  }
  function undo(redo = false) {
    resume();
    setDoc(current => {
      const stack = redo ? current.future : current.past, next = stack.at(-1);
      return !next ? current : redo ? { graph: next, past: [...current.past, current.graph], future: stack.slice(0, -1) } : { graph: next, past: stack.slice(0, -1), future: [...current.future, current.graph] };
    });
  }
  function showError(error: unknown) {
    console.debug("UML action failed:", error);
    setNotice({ kind: "error", text: architectureErrorMessage(error) });
  }
  /** Commits the saved file as a version, once for each run of saves. */
  function record() {
    if (!unrecorded.current) return;
    unrecorded.current = false; recorded.current = Date.now();
    architectureCheckpoint(project, graph.name).then(sha => { if (sha) setVersions(n => n + 1); }, error => { unrecorded.current = true; console.debug("UML version not recorded:", error); });
  }
  /**
   * "now" is an explicit save: it also records a version. Returns true when the graph is saved.
   * One save at a time: a second call waits for the first, then saves the state of the next render.
   */
  async function save(kind: "auto" | "now"): Promise<boolean> {
    if (inflight.current) {
      await inflight.current;
      await new Promise(resolve => setTimeout(resolve));
      return latest.current.save(kind);
    }
    const run = write(kind);
    inflight.current = run;
    try { return await run; } finally { inflight.current = null; }
  }
  async function write(kind: "auto" | "now"): Promise<boolean> {
    const submitted = graph;
    let snapshot: Diagram;
    try { snapshot = diagramSchema.parse(submitted); }
    catch (error) { setPause("invalid"); showError(error); return false; }
    if (JSON.stringify(snapshot) !== JSON.stringify(clean.current)) {
      try { await onSave(snapshot); }
      catch (error) { setPause(error instanceof ArchitectureRequestError && error.status === 409 ? "conflict" : "failed"); showError(error); return false; }
      clean.current = snapshot; unrecorded.current = true; setPause(null);
      setDoc(current => ({ ...current, graph: JSON.stringify(current.graph) === JSON.stringify(submitted) ? snapshot : current.graph }));
    }
    if (kind === "now" || Date.now() - recorded.current > CHECKPOINT_MS) record();
    if (kind === "now") setNotice({ kind: "status", text: "Saved. doi recorded this version." });
    return true;
  }
  /** The inspector is a portal in the side panel: its fields belong to the editor too. */
  const inspectorRef = useRef(inspector);
  inspectorRef.current = inspector;
  const latest = useRef({ save, record, onBack });
  useLayoutEffect(() => { latest.current = { save, record, onBack }; });
  useEffect(() => {
    if (!dirty || busy || pause || gesturing) return;
    const timer = setTimeout(() => { void latest.current.save("auto"); }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [graph, dirty, busy, pause, gesturing]);
  useEffect(() => () => latest.current.record(), []);
  /** Back saves the last edits first. An edit that cannot save goes to the app's discard question. */
  async function back() {
    if (!dirty) { onBack(true); return; }
    if (pause) { onBack(false); return; }
    if (await save("auto")) latest.current.onBack(true);
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
    if (changes.some(change => change.type === "select")) setSelected(current => { const next = new Set(current); for (const change of changes) if (change.type === "select") { if (change.selected) next.add(change.id); else next.delete(change.id); } return next.size === current.size && [...next].every(id => current.has(id)) ? current : next; });
    // Guides apply to a pointer drag of one box, including the final position when the drag ends.
    const moving = changes.filter(c => c.type === "position" && c.position);
    const single = snap && moving.length === 1 && gesture.current && !changes.some(c => c.type === "dimensions") ? moving[0] : undefined;
    if (single?.type === "position" && single.position) {
      const node = graph.nodes.find(n => n.id === single.id);
      const snapped = snapToGuides(graph, single.id, single.position, 6 / (flow?.getZoom() ?? 1));
      setGuides({ origin: node?.parent ? absolutePosition(graph, node.parent) : { x: 0, y: 0 }, lines: single.dragging ? snapped.guides : [] });
      changes = changes.map(c => c === single ? { ...single, position: snapped.position } : c);
    } else if (moving.some(c => c.type === "position" && !c.dragging)) setGuides(current => current.lines.length ? { ...current, lines: [] } : current);
    if (changes.some(c => c.type === "position" || c.type === "dimensions" && c.setAttributes || c.type === "remove")) edit(g => applyGraphChanges(g, changes));
  }
  function duplicate() { const result = duplicateItems(graph, selected); edit(() => result.graph); setSelected(result.ids); }
  function copy(cut: boolean): Clipboard | null {
    const clip = copyItems(graph, selected);
    if (!clip) { setNotice({ kind: "error", text: `Select one or more boxes to ${cut ? "cut" : "copy"}.` }); return null; }
    if (cut && clip.nodes.some(n => n.locked)) { setNotice({ kind: "error", text: "Unlock the selected boxes and the boxes in the selected groups before you cut them." }); return null; }
    clipboard.current = { clip, pastes: 0 };
    if (cut) { const ids = new Set([...clip.nodes.map(n => n.id), ...selected]); edit(g => removeItems(g, ids)); setSelected(new Set()); }
    setNotice({ kind: "status", text: `${cut ? "Cut" : "Copied"} ${clip.nodes.length} box${clip.nodes.length === 1 ? "" : "es"} and ${clip.edges.length} connector${clip.edges.length === 1 ? "" : "s"}.` });
    return clip;
  }
  function paste(clip: Clipboard | null) {
    if (!clip) return;
    if (clipboard.current?.clip !== clip) clipboard.current = { clip, pastes: 0 };
    const count = ++clipboard.current.pastes;
    const result = pasteItems(graph, clip, { x: 24 * count, y: 24 * count });
    if ("error" in result) { setNotice({ kind: "error", text: result.error }); return; }
    edit(() => result.graph); setSelected(result.ids);
  }
  function arrange(change: (graph: Diagram) => Diagram | { error: string } | { graph: Diagram; select: Set<string> }) {
    const result = change(graph);
    if ("error" in result) { setNotice({ kind: "error", text: result.error }); return; }
    if ("select" in result) { edit(() => result.graph); setSelected(result.select); return; }
    edit(() => result);
  }
  const group = () => arrange(g => { const r = groupItems(g, selected); return "error" in r ? r : { graph: r.graph, select: new Set([r.group]) }; });
  const ungroup = () => arrange(g => { const r = ungroupItems(g, selected); return "error" in r ? r : { graph: r.graph, select: r.children }; });
  const order = (mode: OrderMode) => arrange(g => reorderItems(g, selected, mode));
  const align = (mode: AlignMode) => arrange(g => alignItems(g, selected, mode));
  const lock = (locked: boolean) => arrange(g => ({ ...g, nodes: g.nodes.map(n => selected.has(n.id) ? { ...n, locked } : n), edges: g.edges.map(e => selected.has(e.id) ? { ...e, locked } : e) }));
  function fitSelection() {
    const ids = [...selected].filter(id => graph.nodes.some(n => n.id === id));
    if (ids.length) flow?.fitView({ nodes: ids.map(id => ({ id })), padding: 0.3, maxZoom: 1.5 }).catch(showError);
  }
  const nodes = useMemo(() => flowNodes(graph, selected).map(node => ({ ...node, data: { ...node.data, onGesture: (active: boolean) => active ? beginGesture() : endGesture() } })), [graph, selected]);
  const edges = useMemo(() => flowEdges(graph, selected), [graph, selected]);
  const pickedNode = selected.size === 1 ? graph.nodes.find(n => selected.has(n.id)) : undefined;
  const pickedEdge = selected.size === 1 ? graph.edges.find(e => selected.has(e.id)) : undefined;
  const selectedNodes = graph.nodes.filter(n => selected.has(n.id));
  const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
  const arrows: Readonly<Record<string, [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const selectedGroups = graph.nodes.filter(n => selected.has(n.id) && n.shape === "group");
  // Align and distribute count a group with its selected children as one unit.
  const arrangeable = movableNodes(graph, selected).length;
  function onKey(event: KeyboardEvent) {
    const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
    if (mod && key === "s") { event.preventDefault(); if (!busy) void save("now"); return; }
    if (editable(document.activeElement)) return;
    const step = arrows[event.key];
    if (step && !mod && !event.altKey) {
      if (!selectedNodes.length) return;
      event.preventDefault(); event.stopPropagation();
      const distance = event.shiftKey ? 16 : 1;
      edit(g => nudgeItems(g, selected, step[0] * distance, step[1] * distance));
      return;
    }
    const run = (action: () => void) => { event.preventDefault(); event.stopPropagation(); action(); };
    if (mod && key === "z") run(() => undo(event.shiftKey));
    else if (mod && key === "y") run(() => undo(true));
    else if (mod && key === "d" && selectedNodes.length) run(duplicate);
    else if (mod && key === "a") run(() => setSelected(new Set([...graph.nodes, ...graph.edges].map(item => item.id))));
    else if (mod && key === "g") run(event.shiftKey ? ungroup : group);
    else if (!mod && (key === "delete" || key === "backspace")) run(() => { edit(g => removeItems(g, selected)); setSelected(new Set()); });
    else if (key === "escape") {
      const menus = section.current?.querySelectorAll<HTMLDetailsElement>(".uml-toolbar details[open]") ?? [];
      if (menus.length) { for (const menu of menus) menu.open = false; return; }
      if (selected.size) setSelected(new Set());
    }
  }
  function onClipboard(event: ClipboardEvent) {
    if (editable(document.activeElement) || !event.clipboardData) return;
    // A text selection belongs to the user: copy and cut leave it to the browser.
    const text = window.getSelection();
    if (event.type !== "paste" && text && !text.isCollapsed) return;
    if (event.type === "paste") {
      const clip = readClipboard(event.clipboardData.getData("text/plain"));
      if (clip) { event.preventDefault(); paste(clip); }
      return;
    }
    if (!selected.size) return;
    const clip = copy(event.type === "cut");
    if (clip) { event.preventDefault(); event.clipboardData.setData("text/plain", JSON.stringify(clip)); }
  }
  const handlers = useRef({ onKey, onClipboard });
  useLayoutEffect(() => { handlers.current = { onKey, onClipboard }; });
  useEffect(() => {
    /**
     * Shortcuts act when the focus is in the editor or on the page body, never in a field or over a dialog.
     * Chrome can send a clipboard event to an old text selection elsewhere, so the focus decides, not the event target.
     */
    const inScope = () => {
      const focus = document.activeElement;
      return !document.querySelector('[aria-modal="true"]') && (!focus || focus === document.body || !!section.current?.contains(focus) || !!inspectorRef.current?.contains(focus));
    };
    const key = (event: KeyboardEvent) => { if (typeof event.key === "string" && inScope()) handlers.current.onKey(event); };
    const clip = (event: ClipboardEvent) => { if (inScope()) handlers.current.onClipboard(event); };
    document.addEventListener("keydown", key, true);
    for (const type of ["copy", "cut", "paste"] as const) document.addEventListener(type, clip);
    return () => { document.removeEventListener("keydown", key, true); for (const type of ["copy", "cut", "paste"] as const) document.removeEventListener(type, clip); };
  }, []);
  return <section className="uml-workspace" aria-label="UML editor" ref={section}>
    <header className="uml-canvas-header"><button className="btn btn-ghost" onClick={() => void back()} disabled={busy}>← Back to UI design</button><strong>{graph.name}</strong><span className="chip">UML</span><span className={`uml-save-state${pause ? " field-error" : ""}`} role="status">{busy ? "Saving…" : pause === "conflict" ? "Not saved: changed elsewhere" : pause ? "Not saved" : dirty ? "Unsaved changes" : "Saved"}</span><button className="btn btn-primary" disabled={busy} title="Save now and record a version (Ctrl/⌘S)" onClick={() => void save("now")}>Save diagram</button><button className="btn btn-ghost" disabled={busy} onClick={onReload}>Load latest</button></header>
    <div className="uml-toolbar" aria-label="Diagram tools">
      <details><summary className="btn btn-secondary">+ Shape</summary><div className="uml-shape-menu">{shapeSchema.options.map(shape => <button className="btn" key={shape} disabled={graph.nodes.length >= 2000} onClick={event => { add(shape); event.currentTarget.closest("details")?.removeAttribute("open"); }}>Add {shape}</button>)}</div></details>
      <button className="btn btn-secondary" disabled={selectedNodes.length !== 2 || graph.edges.length >= 4000} onClick={() => { const [a, b] = selectedNodes; if (a && b) connect({ source: a.id, target: b.id, sourceHandle: "right", targetHandle: "left" }); }}>Connect selected</button>
      <button className="btn btn-ghost" onClick={() => undo()} disabled={!doc.past.length}>Undo</button><button className="btn btn-ghost" onClick={() => undo(true)} disabled={!doc.future.length}>Redo</button>
      <button className="btn btn-ghost" onClick={duplicate} disabled={!selectedNodes.length}>Duplicate</button><button className="btn btn-ghost" disabled={!selected.size} onClick={() => { edit(g => removeItems(g, selected)); setSelected(new Set()); }}>Delete selected</button>
      <label className="uml-check"><input type="checkbox" checked={grid} onChange={e => setGrid(e.target.checked)}/>Grid</label><label className="uml-check"><input type="checkbox" checked={snap} onChange={e => setSnap(e.target.checked)}/>Snap</label>
      <details className="uml-menu"><summary className="btn btn-secondary">Arrange</summary><div className="uml-shape-menu" role="group" aria-label="Arrange" onClick={event => { if (event.target instanceof HTMLButtonElement) event.currentTarget.closest("details")?.removeAttribute("open"); }}>
        <span className="uml-menu-label">Align</span>
        {([["left", "Align left"], ["centre", "Align centres"], ["right", "Align right"], ["top", "Align top"], ["middle", "Align middles"], ["bottom", "Align bottom"]] as const).map(([mode, label]) => <button className="btn" key={mode} disabled={arrangeable < 2} onClick={() => align(mode)}>{label}</button>)}
        <span className="uml-menu-label">Distribute</span>
        <button className="btn" disabled={arrangeable < 3} onClick={() => arrange(g => distributeItems(g, selected, "horizontal"))}>Distribute horizontally</button>
        <button className="btn" disabled={arrangeable < 3} onClick={() => arrange(g => distributeItems(g, selected, "vertical"))}>Distribute vertically</button>
        <span className="uml-menu-label">Order</span>
        {([["front", "Bring to front"], ["forward", "Bring forward"], ["backward", "Send backward"], ["back", "Send to back"]] as const).map(([mode, label]) => <button className="btn" key={mode} disabled={!selectedNodes.some(n => !n.locked)} onClick={() => order(mode)}>{label}</button>)}
        <span className="uml-menu-label">Group</span>
        <button className="btn" disabled={!selectedNodes.length} onClick={group}>Group selection</button>
        <button className="btn" disabled={!selectedGroups.length} onClick={ungroup}>Ungroup</button>
        <button className="btn" disabled={!selected.size} onClick={() => lock(true)}>Lock selection</button>
        <button className="btn" disabled={!selected.size} onClick={() => lock(false)}>Unlock selection</button>
      </div></details>
      <button className="btn btn-ghost" disabled={!selected.size} onClick={() => copy(false)}>Copy</button>
      <button className="btn btn-ghost" disabled={!clipboard.current} onClick={() => paste(clipboard.current?.clip ?? null)}>Paste</button>
      <button className="btn btn-ghost" onClick={() => { flow?.fitView({ padding: 0.15 }).catch(showError); }}>Fit all</button>
      <button className="btn btn-ghost" disabled={!selectedNodes.length} onClick={fitSelection}>Fit selection</button>
      <button className="btn btn-secondary" onClick={() => { try { saveBlob(new Blob([diagramFile(graph)], { type: "application/json" }), `${graph.id}.doi-diagram.json`); } catch (error) { showError(error); } }}>Export JSON</button>
      <label className={`btn btn-secondary${busy ? " is-disabled" : ""}`}>Import JSON<input className="visually-hidden" type="file" accept=".json,application/json" disabled={busy} onChange={async event => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; try { if (file.size > MAX_DIAGRAM_FILE_BYTES) throw new Error("The diagram file exceeds 4 MB."); await onImport(readDiagramFile(await file.text())); } catch (error) { showError(error); } }}/></label>
    </div>
    {notice && <p className={`uml-notice${notice.kind === "error" ? " field-error" : ""}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p>}
    <div className="uml-flow" ref={canvas}><ReactFlow<FlowNode, FlowEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={setFlow} onNodesChange={changes} onEdgesChange={changes} onConnect={connection => connect(connection)} onReconnect={(edge, connection) => connect(connection, edge.id)} onNodeDragStart={beginGesture} onNodeDragStop={endGesture} onSelectionDragStart={beginGesture} onSelectionDragStop={endGesture} onPaneClick={() => setSelected(new Set())} connectionMode={ConnectionMode.Loose} selectionOnDrag panOnDrag={[1, 2]} multiSelectionKeyCode={["Control", "Meta", "Shift"]} deleteKeyCode={null} snapToGrid={snap} snapGrid={[16, 16]} defaultViewport={{ x: 40, y: 60, zoom: 1 }} minZoom={0.2} maxZoom={3} colorMode="system">
      {grid && <Background gap={16} size={1}/>}<Controls showInteractive={false}/>
      <ViewportPortal>{guides.lines.map(line => <div key={`${line.axis}${line.at}`} className={`uml-guide uml-guide--${line.axis}`} data-testid="uml-guide" style={line.axis === "x" ? { left: guides.origin.x + line.at } : { top: guides.origin.y + line.at }}/>)}</ViewportPortal>
    </ReactFlow></div>
    <footer className="uml-status">{graph.nodes.length} boxes · {graph.edges.length} connectors · {selected.size} selected<span>Drag handles to connect · Shift-click to select several · Arrows nudge (Shift: 16 px) · Ctrl/⌘C, X, V copy · Ctrl/⌘G group, Shift ungroups · Ctrl/⌘S to save</span></footer>
    {inspector && createPortal(<fieldset className="uml-inspector">
      {tab === "uml" && (pickedNode ? <ArchitectureNodeInspector node={pickedNode} designs={designs} onChange={node => edit(g => ({ ...g, nodes: g.nodes.map(n => n.id === node.id ? node : n) }))} onReference={onReference}/> : pickedEdge ? <ArchitectureEdgeInspector edge={pickedEdge} onChange={edge => edit(g => ({ ...g, edges: g.edges.map(e => e.id === edge.id ? edge : e) }))}/> : <p className="uml-empty">Select a box or connector to edit its properties.</p>)}
      {tab === "comments" && <div className="uml-properties"><h3>Diagram comments</h3>{graph.comments.map(c => <article className="uml-comment" key={c.id}><strong>{c.status === "done" ? "Done" : "Open"} · {c.item}</strong><p>{c.text}</p><button className="btn btn-ghost" onClick={() => edit(g => ({ ...g, comments: g.comments.map(item => item.id === c.id ? { ...item, status: item.status === "open" ? "done" : "open" } : item) }))}>{c.status === "open" ? "Mark done" : "Reopen"}</button></article>)}<label className="field">Comment on the selected item<textarea className="textarea" maxLength={5000} value={comment} onChange={e => setComment(e.target.value)}/></label><button className="btn btn-secondary" disabled={selected.size !== 1 || !comment.trim()} onClick={() => { const item = [...selected][0]; if (item) { edit(g => ({ ...g, comments: [...g.comments, { id: crypto.randomUUID(), item, text: comment.trim(), status: "open", createdAt: new Date().toISOString() }] })); setComment(""); } }}>Add diagram comment</button></div>}
      {tab === "history" && <ArchitectureHistory project={project} diagram={graph} refresh={versions} past={doc.past} onSessionRestore={snapshot => edit(() => snapshot)} onRestore={restored => { record(); edit(g => ({ ...restored, id: g.id })); setNotice({ kind: "status", text: "Restored the saved version. Undo reverses it." }); }}/>}
    </fieldset>, inspector)}
  </section>;
}
