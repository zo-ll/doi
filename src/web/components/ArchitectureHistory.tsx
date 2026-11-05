import { useEffect, useState } from "react";
import type { Diagram } from "../../architecture/schema.ts";
import { architectureErrorMessage } from "../../architecture/errors.ts";
import { architectureVersion, architectureVersions, type ArchitectureVersion } from "../architecture.ts";

/** Saved versions of the project's UML file. A restore replaces the open diagram as an undoable edit. */
export function ArchitectureHistory({ project, diagram, refresh, past, onRestore, onSessionRestore }: {
  project: string; diagram: Diagram; refresh: number; past: Diagram[];
  onRestore: (diagram: Diagram) => void; onSessionRestore: (diagram: Diagram) => void;
}) {
  const [versions, setVersions] = useState<ArchitectureVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    architectureVersions(project, controller.signal).then(setVersions, cause => { if (!controller.signal.aborted) setError(architectureErrorMessage(cause)); });
    return () => controller.abort();
  }, [project, refresh]);
  async function restore(version: ArchitectureVersion) {
    setPending(version.sha); setError(null);
    try {
      const state = await architectureVersion(project, version.sha);
      const found = state.diagrams.find(d => d.id === diagram.id);
      if (!found) { setError("This version does not contain this diagram."); return; }
      onRestore(found);
    } catch (cause) { setError(architectureErrorMessage(cause)); }
    finally { setPending(null); }
  }
  return <div className="uml-properties">
    <h3>Saved versions</h3>
    <p>doi records a version when you select Save diagram, when you leave the diagram, and every 5 minutes while autosave runs. A restore is an edit: Undo reverses it.</p>
    {error && <p className="field-error" role="alert">{error}</p>}
    {versions === null && !error && <p className="uml-empty">Load versions…</p>}
    {versions?.length === 0 && <p className="uml-empty">No saved version yet.</p>}
    <ul className="uml-versions" aria-label="Saved versions">
      {versions?.map(version => <li key={version.sha}>
        <span><strong>{new Date(version.at).toLocaleString()}</strong><small>{version.message}</small></span>
        <button className="btn btn-ghost btn-sm" disabled={pending !== null} onClick={() => void restore(version)} aria-label={`Restore the version of ${new Date(version.at).toLocaleString()}`}>{pending === version.sha ? "Restore…" : "Restore"}</button>
      </li>)}
    </ul>
    <h3>This session</h3>
    {past.length === 0 && <p className="uml-empty">No edits in this session yet.</p>}
    {past.toReversed().map((snapshot, index) => <button key={index} className="btn btn-ghost" onClick={() => onSessionRestore(snapshot)}>Restore session edit {past.length - index} · {snapshot.nodes.length} boxes</button>)}
  </div>;
}
