// HTML export (#46) without React: the request URL, the report header and the download.
import { REPORT_HEADER } from "../export/report.ts";

export type ExportFormat = "folder" | "page";

export interface ExportReport {
  missing: string[];
  warnings: string[];
}

export function exportUrl(project: string, design: string, format: ExportFormat, stripOids: boolean): string {
  const query = new URLSearchParams({ format, oids: stripOids ? "strip" : "keep" });
  return `/api/projects/${project}/designs/${design}/export?${query}`;
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

/** Runs the export and saves the file through the browser. Returns the file name and the report. */
export async function runExport(url: string, fallback: string): Promise<ExportReport & { file: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  const file = fileNameOf(res.headers.get("content-disposition"), fallback);
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = href;
  a.download = file;
  a.click();
  // The click starts the download at once; the URL is not needed after that.
  setTimeout(() => URL.revokeObjectURL(href), 0);
  return { file, ...parseReport(res.headers.get(REPORT_HEADER)) };
}
