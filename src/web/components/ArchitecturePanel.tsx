import { useState } from "react";
import { createDiagram, type Architecture, type Diagram } from "../../architecture/schema.ts";
import type { useArchitecture } from "../architecture.ts";

type Controller = ReturnType<typeof useArchitecture>;
export function ArchitecturePanel({ controller, current, dirty, tab, onOpen, onClose, inspectorRef }: {
  controller: Controller; current: string | null; dirty: boolean; tab: "uml" | "comments" | "history";
  onOpen: (id: string) => void; onClose: () => void; inspectorRef: (element: HTMLDivElement | null) => void;
}) {
  const [name, setName] = useState("System overview");
  const [error, setError] = useState<string | null>(null);
  const { load, busy } = controller;
  if (load.state === "loading") return <p className="uml-empty" role="status">Load UML diagrams…</p>;
  if (load.state === "error") return <div className="uml-empty" role="alert">{load.message}<button className="btn" onClick={controller.reload}>Try again</button></div>;
  const state = load.data.state;
  const blocked = busy || dirty;
  async function change(next: Architecture, open?: string) {
    setError(null);
    try { await controller.write(next); if (open) onOpen(open); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
  }
  function add() {
    if (!name.trim()) return;
    const diagram = createDiagram(name);
    change({ ...state, enabled: true, diagrams: [...state.diagrams, diagram] }, diagram.id);
  }
  function rename(diagram: Diagram) {
    const next = window.prompt("Diagram name", diagram.name)?.trim();
    if (!next || next === diagram.name) return;
    if (next.length > 200) { setError("Use at most 200 characters for a diagram name."); return; }
    change({ ...state, diagrams: state.diagrams.map(d => d.id === diagram.id ? { ...d, name: next } : d) });
  }
  return <div className="uml-project-panel">
    {(error || controller.error) && <p className="field-error" role="alert">{error || controller.error}</p>}
    {tab === "uml" && <>
      {!state.enabled ? <div className="uml-empty">
        <div className="uml-empty-icon" aria-hidden="true">□ → □</div><h2>Add a map of your project</h2>
        <p>UML is optional. Use boxes and arrows to show how parts connect. Your UI designs stay unchanged.</p>
        <button className="btn btn-primary" disabled={blocked} onClick={() => {
          const diagrams = state.diagrams.length ? state.diagrams : [createDiagram()];
          change({ ...state, enabled: true, diagrams }, diagrams[0]?.id);
        }}>{state.diagrams.length ? "Show UML in this project" : "Add UML to this project"}</button>
        {state.diagrams.length > 0 && <p>{state.diagrams.length} saved diagram{state.diagrams.length === 1 ? "" : "s"}. Nothing was deleted.</p>}
      </div> : <>
        <div className="uml-panel-heading"><strong>Diagrams</strong><button className="btn btn-ghost btn-sm" disabled={blocked} onClick={() => {
          change({ ...state, enabled: false }).then(saved => { if (saved) onClose(); }).catch(() => {});
        }}>Hide UML</button></div>
        <div className="uml-diagram-list">{state.diagrams.map(diagram => <div className="uml-diagram-row" key={diagram.id}>
          <button className={`btn uml-diagram-choice${current === diagram.id ? " is-current" : ""}`} disabled={busy && current !== diagram.id} onClick={() => onOpen(diagram.id)}>{diagram.name}<small>{diagram.nodes.length} items</small></button>
          <details><summary aria-label={`Actions for ${diagram.name}`}>⋯</summary><div className="uml-actions" onClick={event => { if (event.target instanceof HTMLButtonElement) event.currentTarget.closest("details")?.removeAttribute("open"); }}>
            <button className="btn" disabled={blocked} onClick={() => rename(diagram)}>Rename</button>
            <button className="btn" disabled={blocked} onClick={() => { const copy = { ...structuredClone(diagram), id: crypto.randomUUID(), name: `${diagram.name} copy`.slice(0, 200) }; change({ ...state, diagrams: [...state.diagrams, copy] }, copy.id); }}>Duplicate</button>
            <button className="btn" disabled={blocked} onClick={() => { if (window.confirm(`Delete "${diagram.name}"? This removes its boxes, arrows and comments.`)) change({ ...state, diagrams: state.diagrams.filter(d => d.id !== diagram.id) }).then(saved => { if (saved && current === diagram.id) onClose(); }).catch(() => {}); }}>Delete</button>
          </div></details>
        </div>)}</div>
        <div className="uml-add-diagram"><input aria-label="New diagram name" maxLength={200} value={name} onChange={e => setName(e.target.value)} disabled={blocked}/><button className="btn btn-secondary" onClick={add} disabled={blocked || !name.trim() || state.diagrams.length >= 50}>New diagram</button></div>
        {dirty && <p className="uml-hint">Wait for the save before diagram changes.</p>}
      </>}
    </>}
    {current && <div className="uml-inspector-host" ref={inspectorRef}/>}
  </div>;
}
