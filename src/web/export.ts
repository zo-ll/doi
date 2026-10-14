// HTML export (#46) without React: the request URL, the report header and the download.
import { REPORT_HEADER } from "../export/report.ts";

export type ExportFormat = "folder" | "page" | "png" | "pdf";

export interface ExportReport {
  missing: string[];
  warnings: string[];
}

export interface ExportChoice {
  format: ExportFormat;
  stripOids: boolean;
  /** PNG and PDF: a frame id, or "all" (PNG only). */
  frame: string;
  /** PNG: 1 or 2 device pixels per CSS pixel. */
  scale: 1 | 2;
  /** PNG: the whole page height, not only the frame. */
  fullPage: boolean;
}

export function exportUrl(project: string, design: string, choice: ExportChoice): string {
  const query = new URLSearchParams({ format: choice.format });
  if (choice.format === "folder" || choice.format === "page") query.set("oids", choice.stripOids ? "strip" : "keep");
  if (choice.format === "png" || choice.format === "pdf") query.set("frame", choice.frame);
  if (choice.format === "png") {
    query.set("scale", String(choice.scale));
    query.set("full", choice.fullPage ? "1" : "0");
  }
  return `/api/projects/${project}/designs/${design}/export?${query}`;
}

/** The file name to use when the response has none. */
export function fallbackName(design: string, choice: ExportChoice): string {
  if (choice.format === "folder") return `${design}.zip`;
  if (choice.format === "page") return `${design}.html`;
  if (choice.format === "pdf") return `${design}-${choice.frame}.pdf`;
  return choice.frame === "all" ? `${design}-png.zip` : `${design}-${choice.frame}.png`;
}

/** The report of an export response. A missing or broken header gives an empty report. */
export function parseReport(header: string | null): ExportReport {
  try {
    const raw = JSON.parse(decodeURIComponent(header ?? "")) as Partial<ExportReport>;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { missing: strings(raw.missing), warnings: strings(raw.warnings) };
  } catch {
    return { missing: [], warnings: [] };
  }
}

/** The file name in a Content-Disposition header. */
export function fileNameOf(header: string | null, fallback: string): string {
  return header?.match(/filename="([^"]+)"/)?.[1] ?? fallback;
}

/** The handoff bundle (#49): a POST with the user's HANDOFF.md, answered with a ZIP. */
export function bundleRequest(project: string, design: string, markdown: string): { url: string; init: RequestInit } {
  return {
    url: `/api/projects/${project}/designs/${design}/handoff/bundle`,
    init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ markdown }) },
  };
}

/** "412 KB", "1.9 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Runs the export and saves the file through the browser. Returns the file name, its size and the report. */
export async function runExport(url: string, fallback: string, init?: RequestInit): Promise<ExportReport & { file: string; size: number }> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  const file = fileNameOf(res.headers.get("content-disposition"), fallback);
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = file;
  a.click();
  // The click starts the download at once; the URL is not needed after that.
  setTimeout(() => URL.revokeObjectURL(href), 0);
  return { file, size: blob.size, ...parseReport(res.headers.get(REPORT_HEADER)) };
}
