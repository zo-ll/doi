import { useState } from "react";
import type { Diagram } from "../../architecture/schema.ts";
import { diagramSvg, type ExportTheme } from "../../architecture/svg.ts";
import { architectureErrorMessage } from "../../architecture/errors.ts";
import { architectureImage } from "../architecture.ts";
import { saveBlob } from "../export.ts";

type Format = "svg" | "png" | "pdf";
/** The app theme: `data-theme` on <html> wins, else the system setting. */
function appTheme(): ExportTheme {
  const set = document.documentElement.dataset.theme;
  if (set === "dark" || set === "light") return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
const fileName = (name: string, format: Format) => `${name.normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80) || "diagram"}.${format}`;

/** SVG renders in the browser; PNG and PDF come from the server. Both use the same SVG. */
export function ArchitectureImageExport({ project, graph, selected, onNotice }: {
  project: string; graph: Diagram; selected: ReadonlySet<string>; onNotice: (notice: { kind: "status" | "error"; text: string }) => void;
}) {
  const [format, setFormat] = useState<Format>("png");
  const [scope, setScope] = useState<"all" | "selection">("all");
  const [theme, setTheme] = useState<ExportTheme>(appTheme);
  const [background, setBackground] = useState(true);
  const [scale, setScale] = useState<1 | 2>(2);
  const [pending, setPending] = useState(false);
  const boxes = graph.nodes.filter(n => selected.has(n.id)).map(n => n.id);
  const useSelection = scope === "selection" && boxes.length > 0;
  async function download() {
    const ids = useSelection ? new Set(boxes) : undefined;
    setPending(true);
    try {
      if (format === "svg") {
        const image = diagramSvg(graph, { theme, background, ids });
        if ("error" in image) { onNotice({ kind: "error", text: image.error }); return; }
        saveBlob(new Blob([image.svg], { type: "image/svg+xml" }), fileName(graph.name, "svg"));
      } else {
        const blob = await architectureImage(project, { format, diagram: graph, theme, background, ids: ids ? [...ids] : undefined, scale });
        saveBlob(blob, fileName(graph.name, format));
      }
      onNotice({ kind: "status", text: `Exported ${useSelection ? "the selection" : "the diagram"} as ${format.toUpperCase()}.` });
    } catch (error) { onNotice({ kind: "error", text: architectureErrorMessage(error) }); }
    finally { setPending(false); }
  }
  return <details className="uml-menu"><summary className="btn btn-secondary">Export image</summary>
    <div className="uml-shape-menu uml-export-menu" role="group" aria-label="Export image">
      <label className="field">Format<select className="select" value={format} onChange={e => setFormat(e.target.value === "svg" || e.target.value === "pdf" ? e.target.value : "png")}><option value="svg">SVG</option><option value="png">PNG</option><option value="pdf">PDF</option></select></label>
      <label className="field">Scope<select className="select" value={useSelection ? "selection" : "all"} onChange={e => setScope(e.target.value === "selection" ? "selection" : "all")}><option value="all">Whole diagram</option><option value="selection" disabled={!boxes.length}>Selected boxes ({boxes.length})</option></select></label>
      <label className="field">Colours<select className="select" value={theme} onChange={e => setTheme(e.target.value === "light" ? "light" : "dark")}><option value="dark">Dark</option><option value="light">Light</option></select></label>
      <label className="uml-check"><input type="checkbox" checked={background} onChange={e => setBackground(e.target.checked)}/>Background{format === "pdf" && !background ? " (white page)" : ""}</label>
      {format === "png" && <label className="field">Size<select className="select" value={scale} onChange={e => setScale(e.target.value === "1" ? 1 : 2)}><option value="1">1×</option><option value="2">2× (sharp)</option></select></label>}
      <button className="btn btn-primary" disabled={pending} onClick={() => void download()}>{pending ? "Export…" : `Download ${format.toUpperCase()}`}</button>
    </div>
  </details>;
}
