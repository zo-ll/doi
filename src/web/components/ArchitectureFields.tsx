export function TextField({ label, value, onChange, multiline = false }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean }) {
  return <label className="field">{label}{multiline ? <textarea className="textarea nodrag" value={value} onChange={e => onChange(e.target.value)}/> : <input className="input nodrag" value={value} onChange={e => onChange(e.target.value)}/>}</label>;
}
export function NumberField({ label, value, onChange, min = -100000, max = 100000, step = 1 }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number }) {
  return <label className="field">{label}<input className="input nodrag" type="number" min={min} max={max} step={step} value={value} onChange={e => { const n = e.target.valueAsNumber; if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n))); }}/></label>;
}
export function ColourField({ label, value, fallback, onChange }: { label: string; value: string | null; fallback: string; onChange: (value: string | null) => void }) {
  return <label className="field">{label}<span className="uml-colour"><input type="color" aria-label={label} value={value && /^#[\da-f]{6}$/i.test(value) ? value : fallback} onChange={e => onChange(e.target.value)}/><button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(null)}>Theme</button></span></label>;
}
