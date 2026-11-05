import { useState } from "react";
import { shapeSchema, uiReferenceSchema, type DiagramNode } from "../../architecture/nodes.ts";
import type { z } from "zod";
import { ColourField, NumberField, TextField } from "./ArchitectureFields.tsx";
type Reference = z.infer<typeof uiReferenceSchema>;
export function ArchitectureNodeInspector({ node, designs, onChange, onReference }: {
  node: DiagramNode; designs: string[]; onChange: (node: DiagramNode) => void; onReference: (reference: Reference) => void;
}) {
  const [design, setDesign] = useState(designs[0] ?? "");
  const [page, setPage] = useState("index.html");
  const [oid, setOid] = useState("");
  const [error, setError] = useState("");
  const patch = (next: Partial<DiagramNode>) => onChange({ ...node, ...next });
  return <div className="uml-properties">
    <h3>Selected box</h3>
    <label className="uml-check"><input type="checkbox" checked={node.locked} onChange={e => patch({ locked: e.target.checked })}/>Locked</label>
    <fieldset disabled={node.locked}>
      <TextField label="Box name" required maxLength={200} value={node.name} onChange={name => patch({ name })}/>
      <label className="field">Shape<select className="select" aria-label="Shape" value={node.shape} onChange={e => { const shape = shapeSchema.safeParse(e.target.value); if (shape.success) patch({ shape: shape.data }); }}>{shapeSchema.options.map(shape => <option key={shape}>{shape}</option>)}</select></label>
      <TextField label="Box content" value={node.content} multiline onChange={content => patch({ content })}/>
      {node.shape === "class" && <><TextField label="Stereotype" maxLength={200} value={node.stereotype} onChange={stereotype => patch({ stereotype })}/><TextField label="Attributes" multiline maxLength={5000} value={node.attributes} onChange={attributes => patch({ attributes })}/><TextField label="Operations" multiline maxLength={5000} value={node.operations} onChange={operations => patch({ operations })}/></>}
      <div className="uml-field-row"><NumberField label="X" value={node.position.x} onChange={x => patch({ position: { ...node.position, x } })}/><NumberField label="Y" value={node.position.y} onChange={y => patch({ position: { ...node.position, y } })}/></div>
      <div className="uml-field-row"><NumberField label="Width" min={32} max={4096} value={node.size.width} onChange={width => patch({ size: { ...node.size, width } })}/><NumberField label="Height" min={32} max={4096} value={node.size.height} onChange={height => patch({ size: { ...node.size, height } })}/></div>
      <div className="uml-field-row"><ColourField label="Fill" value={node.style.fill} fallback="#222220" onChange={fill => patch({ style: { ...node.style, fill } })}/><ColourField label="Border" value={node.style.stroke} fallback="#8f8b82" onChange={stroke => patch({ style: { ...node.style, stroke } })}/></div>
      <NumberField label="Text size" min={10} max={48} value={node.style.fontSize} onChange={fontSize => patch({ style: { ...node.style, fontSize } })}/>
    </fieldset>
    <h3>Related UI designs</h3>
    {node.references.map((reference, i) => <div className="uml-ui-reference" key={`${reference.design}/${reference.page}/${reference.node}/${i}`}>
      <button className="btn btn-ghost" onClick={() => onReference(reference)}>↗ {reference.design} / {reference.page}{reference.node ? ` #${reference.node}` : ""}</button>
      <button className="btn btn-ghost btn-sm" aria-label={`Remove UI link ${i + 1}`} disabled={node.locked} onClick={() => patch({ references: node.references.filter((_, n) => n !== i) })}>×</button>
    </div>)}
    <fieldset disabled={node.locked || node.references.length >= 30}>
      <label className="field">UI design<select className="select" aria-label="UI design" value={design} onChange={e => setDesign(e.target.value)}>{designs.map(name => <option key={name}>{name}</option>)}</select></label>
      <TextField label="UI page" required maxLength={200} value={page} onChange={setPage}/><TextField label="UI node (optional)" maxLength={80} value={oid} onChange={setOid}/>
      <button className="btn btn-secondary" disabled={!design} onClick={() => {
        const reference = uiReferenceSchema.safeParse({ design, page, node: oid.trim() || null });
        if (!reference.success) { setError("Use a design, a safe HTML page and a valid node id."); return; }
        patch({ references: [...node.references, reference.data] }); setError("");
      }}>Link UI design</button>
      {error && <p className="field-error" role="alert">{error}</p>}
    </fieldset>
    <details><summary>Box details</summary><code>{node.id}</code></details>
  </div>;
}
