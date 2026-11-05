import { applyRelationship, markerSchema, relationshipSchema, type DiagramEdge } from "../../architecture/edges.ts";
import { lineStyleSchema, sideSchema } from "../../architecture/nodes.ts";
import { ColourField, NumberField, TextField } from "./ArchitectureFields.tsx";

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (value: T) => void }) {
  return <label className="field">{label}<select className="select" value={value} onChange={e => { const next = options.find(option => option === e.target.value); if (next !== undefined) onChange(next); }}>{options.map(option => <option key={option}>{option}</option>)}</select></label>;
}
export function ArchitectureEdgeInspector({ edge, onChange }: { edge: DiagramEdge; onChange: (edge: DiagramEdge) => void }) {
  const patch = (next: Partial<DiagramEdge>) => onChange({ ...edge, ...next });
  const preset = relationshipSchema.options.find(name => { const candidate = applyRelationship(edge, name); return candidate.startMarker === edge.startMarker && candidate.endMarker === edge.endMarker && candidate.line === edge.line; }) ?? "custom";
  return <div className="uml-properties">
    <h3>Selected connector</h3>
    <label className="uml-check"><input type="checkbox" checked={edge.locked} onChange={e => patch({ locked: e.target.checked })}/>Locked</label>
    <fieldset disabled={edge.locked}>
      <Choice label="Relationship" value={preset} options={["custom", ...relationshipSchema.options]} onChange={value => { const result = relationshipSchema.safeParse(value); if (result.success) onChange(applyRelationship(edge, result.data)); }}/>
      <TextField label="Connector label" value={edge.label} onChange={label => patch({ label })}/>
      <div className="uml-field-row"><TextField label="Start label" value={edge.startLabel} onChange={startLabel => patch({ startLabel })}/><TextField label="End label" value={edge.endLabel} onChange={endLabel => patch({ endLabel })}/></div>
      <Choice label="Line style" value={edge.line} options={lineStyleSchema.options} onChange={line => patch({ line })}/>
      <div className="uml-field-row"><Choice label="Start marker" value={edge.startMarker} options={markerSchema.options} onChange={startMarker => patch({ startMarker })}/><Choice label="End marker" value={edge.endMarker} options={markerSchema.options} onChange={endMarker => patch({ endMarker })}/></div>
      <Choice label="Route" value={edge.route} options={["straight", "elbow", "curved"]} onChange={route => patch({ route })}/>
      <div className="uml-field-row"><Choice label="Source side" value={edge.sourceSide} options={sideSchema.options} onChange={sourceSide => patch({ sourceSide })}/><Choice label="Target side" value={edge.targetSide} options={sideSchema.options} onChange={targetSide => patch({ targetSide })}/></div>
      <div className="uml-field-row"><NumberField label="Source position" value={edge.sourceOffset} min={0} max={1} step={0.05} onChange={sourceOffset => patch({ sourceOffset })}/><NumberField label="Target position" value={edge.targetOffset} min={0} max={1} step={0.05} onChange={targetOffset => patch({ targetOffset })}/></div>
      <NumberField label="Line width" value={edge.width} min={0.5} max={8} step={0.5} onChange={width => patch({ width })}/>
      <ColourField label="Line colour" value={edge.colour} fallback="#b4b0a7" onChange={colour => patch({ colour })}/>
      <button className="btn btn-secondary" onClick={() => patch({ source: edge.target, target: edge.source, sourceSide: edge.targetSide, targetSide: edge.sourceSide, sourceOffset: edge.targetOffset, targetOffset: edge.sourceOffset, startLabel: edge.endLabel, endLabel: edge.startLabel, points: edge.points.toReversed() })}>Reverse direction</button>
      <h3>Bend points</h3>
      {edge.points.map((point, index) => <div className="uml-field-row" key={index}><NumberField label={`Bend ${index + 1} X`} value={point.x} onChange={x => patch({ points: edge.points.map((p, i) => i === index ? { ...p, x } : p) })}/><NumberField label={`Bend ${index + 1} Y`} value={point.y} onChange={y => patch({ points: edge.points.map((p, i) => i === index ? { ...p, y } : p) })}/><button className="btn btn-ghost" aria-label={`Remove bend ${index + 1}`} onClick={() => patch({ points: edge.points.filter((_, i) => i !== index) })}>×</button></div>)}
      <button className="btn btn-secondary" disabled={edge.points.length >= 64} onClick={() => patch({ points: [...edge.points, { x: 200, y: 200 }] })}>Add bend point</button>
      {edge.points.length > 0 && <button className="btn btn-ghost" onClick={() => patch({ points: [] })}>Reset route</button>}
    </fieldset>
    <details><summary>Connector details</summary><code>{edge.id}</code></details>
  </div>;
}
