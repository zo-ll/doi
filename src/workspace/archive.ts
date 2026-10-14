import { lstat, readdir, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { unzip, ZipError } from "../export/unzip.ts";
import { zip, type ZipEntry } from "../export/zip.ts";
import type { Price } from "../config.ts";
import { listDesignSystems } from "./design-systems.ts";
import { commitPaths, exportHistory, importHistory } from "./git.ts";
import { listProjects } from "./paths.ts";

/**
 * Export and import of projects and the workspace (#114). doi has no database: an export
 * file is how work moves to another computer or workspace. The file is a ZIP:
 *
 * - `manifest.json`: what the file holds, and optional settings and UI preferences.
 * - `files/projects/<id>/…`, `files/design-systems/<name>/…`: the files as they are now.
 * - `history.fi`: the git history of those paths (`git fast-export`), when the workspace has one.
 */
export const ARCHIVE_FORMAT = "doi-export";
export const ARCHIVE_VERSION = 1;

const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;

export interface UiPrefs {
  theme: "light" | "dark" | null;
  panels: { chat: boolean; side: boolean } | null;
  lastDesign: { project: string; design: string } | null;
}

export interface ArchiveSettings {
  /** "<provider>:<model>" per task. Never keys or key names. */
  models: Record<"generate" | "edit" | "extract", string>;
  prices: Record<string, Price>;
}

export interface Manifest {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  kind: "project" | "workspace";
  createdAt: string;
  projects: { id: string; name: string; designs: string[] }[];
  designSystems: string[];
  history: boolean;
  settings: ArchiveSettings | null;
  ui: UiPrefs | null;
}

export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const utf8 = new TextEncoder();

/** All files under a folder (hidden ones too), as "/" paths relative to `base`. Links are skipped. */
async function filesUnder(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = join(e.parentPath, e.name);
    if ((await lstat(full)).isSymbolicLink()) continue;
    out.push(relative(base, full).split(sep).join("/"));
  }
  return out.sort();
}

/** The export file of some projects (a project export) or of all of them (a workspace export). */
export async function exportArchive(
  workspace: string,
  options: { kind: "project" | "workspace"; projects?: string[]; settings?: ArchiveSettings | null; ui?: UiPrefs | null },
): Promise<{ bytes: Uint8Array<ArrayBuffer>; manifest: Manifest }> {
  const all = await listProjects(workspace);
  const projects = options.kind === "workspace" ? all : all.filter((p) => options.projects?.includes(p.id));
  if (options.kind === "project" && projects.length !== (options.projects?.length ?? 0)) throw new ArchiveError("Project not found.", 404);
  const systems =
    options.kind === "workspace"
      ? await listDesignSystems(workspace)
      : [...new Set(projects.flatMap((p) => (p.designSystem ? [p.designSystem] : [])))];

  const roots = [...projects.map((p) => `projects/${p.id}`), ...systems.map((d) => `design-systems/${d}`)];
  const entries: ZipEntry[] = [];
  for (const root of roots) {
    for (const path of await filesUnder(join(workspace, root), workspace)) {
      entries.push({ path: `files/${path}`, data: new Uint8Array(await Bun.file(join(workspace, path)).arrayBuffer()) });
    }
  }
  const history = roots.length ? await exportHistory(workspace, roots) : null;
  if (history) entries.push({ path: "history.fi", data: history as Uint8Array<ArrayBuffer> });

  const manifest: Manifest = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    kind: options.kind,
    createdAt: new Date().toISOString(),
    projects: projects.map((p) => ({ id: p.id, name: p.name, designs: p.designs })),
    designSystems: systems,
    history: history !== null,
    settings: options.settings ?? null,
    ui: options.ui ?? null,
  };
  entries.unshift({ path: "manifest.json", data: utf8.encode(JSON.stringify(manifest, null, 2)) as Uint8Array<ArrayBuffer> });
  return { bytes: zip(entries), manifest };
}

/** Reads and checks the manifest and every path of an export file. */
export function readArchive(bytes: Uint8Array): { manifest: Manifest; entries: ZipEntry[] } {
  let entries: ZipEntry[];
  try {
    entries = unzip(bytes);
  } catch (e) {
    throw new ArchiveError(e instanceof ZipError ? e.message : "The file cannot be read.");
  }
  const raw = entries.find((e) => e.path === "manifest.json");
  if (!raw) throw new ArchiveError("This is not a doi export: it has no manifest.json.");
  let m: Manifest;
  try {
    m = JSON.parse(new TextDecoder().decode(raw.data)) as Manifest;
  } catch {
    throw new ArchiveError("manifest.json is not valid JSON.");
  }
  if (m?.format !== ARCHIVE_FORMAT) throw new ArchiveError("This is not a doi export.");
  if (m.version > ARCHIVE_VERSION) throw new ArchiveError(`This file is from a newer doi (format ${m.version}). Update doi to import it.`);
  if (m.kind !== "project" && m.kind !== "workspace") throw new ArchiveError("manifest.json has an unknown kind.");
  if (
    !Array.isArray(m.projects) ||
    !m.projects.every((p) => NAME.test(p?.id) && typeof p.name === "string" && Array.isArray(p.designs) && p.designs.every((d) => typeof d === "string" && NAME.test(d)))
  ) {
    throw new ArchiveError("manifest.json lists a bad project.");
  }
  if (!Array.isArray(m.designSystems) || !m.designSystems.every((d) => typeof d === "string" && NAME.test(d))) throw new ArchiveError("manifest.json lists a bad design system.");
  const ids = new Set(m.projects.map((p) => p.id));
  const systems = new Set(m.designSystems);
  for (const e of entries) {
    if (e.path === "manifest.json" || e.path === "history.fi") continue;
    const [top, kind, name, ...rest] = e.path.split("/");
    const ok = top === "files" && rest.length > 0 && ((kind === "projects" && ids.has(name!)) || (kind === "design-systems" && systems.has(name!)));
    if (!ok) throw new ArchiveError(`The file has an unexpected entry: ${e.path}.`);
  }
  return { manifest: m, entries };
}

export interface ImportPlan {
  manifest: Manifest;
  projects: { from: string; to: string; name: string }[];
  /** A design system with the same name and files is reused; else it gets a new name. */
  designSystems: { from: string; to: string; reused: boolean }[];
}

const nextFree = (id: string, taken: Set<string>) => {
  if (!taken.has(id)) return id;
  for (let n = 2; ; n++) if (!taken.has(`${id}-${n}`)) return `${id}-${n}`;
};

/** What an import would do in this workspace: new ids for taken ones, reused or renamed design systems. */
export async function planImport(workspace: string, bytes: Uint8Array): Promise<ImportPlan & { entries: ZipEntry[] }> {
  const { manifest, entries } = readArchive(bytes);
  let taken: Set<string>;
  try {
    taken = new Set((await readdir(join(workspace, "projects"), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    taken = new Set();
  }
  // A taken display name gets a number too, so two projects never look the same in the list.
  const names = new Set((await listProjects(workspace)).map((p) => p.name));
  const projects = manifest.projects.map((p) => {
    const to = nextFree(p.id, taken);
    taken.add(to);
    let name = p.name;
    for (let n = 2; names.has(name); n++) name = `${p.name} ${n}`;
    names.add(name);
    return { from: p.id, to, name };
  });
  const existing = new Set(await listDesignSystems(workspace));
  const designSystems: ImportPlan["designSystems"] = [];
  for (const d of manifest.designSystems) {
    if (!existing.has(d)) {
      existing.add(d);
      designSystems.push({ from: d, to: d, reused: false });
      continue;
    }
    // The same files with the same bytes: the system is already here.
    const prefix = `files/design-systems/${d}/`;
    const theirs = entries.filter((e) => e.path.startsWith(prefix));
    const ours = await filesUnder(join(workspace, "design-systems", d), join(workspace, "design-systems", d));
    let same = ours.length === theirs.length;
    for (const e of theirs) {
      if (!same) break;
      const file = Bun.file(join(workspace, "design-systems", d, e.path.slice(prefix.length)));
      same = (await file.exists()) && Buffer.compare(Buffer.from(await file.arrayBuffer()), Buffer.from(e.data)) === 0;
    }
    const to = same ? d : nextFree(d, existing);
    existing.add(to);
    designSystems.push({ from: d, to, reused: same });
  }
  return { manifest, projects, designSystems, entries };
}

export interface ImportResult extends ImportPlan {
  history: boolean;
  commit: string | null;
  commitError?: string;
}

/** Imports an export file: files, history and links follow the plan. The caller applies settings and UI preferences. */
export async function importArchive(workspace: string, bytes: Uint8Array): Promise<ImportResult> {
  const plan = await planImport(workspace, bytes);
  const { manifest, entries } = plan;
  const projectTo = new Map(plan.projects.map((p) => [p.from, p.to]));
  const systemTo = new Map(plan.designSystems.map((d) => [d.from, d]));

  // 1. History first: the merge brings the files of the last commit; the files below win.
  let ids = new Map<string, string>();
  let history = false;
  const stream = entries.find((e) => e.path === "history.fi");
  if (stream && (await Bun.file(join(workspace, ".git", "HEAD")).exists())) {
    const renames: [string, string | null][] = [
      ...plan.projects.map((p): [string, string] => [`projects/${p.from}/`, `projects/${p.to}/`]),
      ...plan.designSystems.map((d): [string, string | null] => [`design-systems/${d.from}/`, d.reused ? null : `design-systems/${d.to}/`]),
    ];
    const label = manifest.kind === "workspace" ? "workspace" : `project ${plan.projects[0]?.name ?? ""}`.trim();
    const r = await importHistory(workspace, stream.data, renames, `History of the imported ${label}`);
    if (r) {
      ids = r.ids;
      history = true;
    }
  }

  // 2. The files as they were at the export.
  const written = new Map<string, Set<string>>(); // root → its files
  for (const e of entries) {
    const [, kind, name, ...rest] = e.path.split("/");
    if (kind !== "projects" && kind !== "design-systems") continue;
    const sys = kind === "design-systems" ? systemTo.get(name!) : undefined;
    if (sys?.reused) continue;
    const root = kind === "projects" ? `projects/${projectTo.get(name!)}` : `design-systems/${sys!.to}`;
    const rel = rest.join("/");
    let data: Uint8Array = e.data;
    if (kind === "projects") data = rewriteProjectFile(rel, data, plan, ids, plan.projects.find((p) => p.from === name));
    data = rewriteDsLinks(rel, data, plan);
    await Bun.write(join(workspace, root, rel), data);
    if (!written.has(root)) written.set(root, new Set());
    written.get(root)!.add(rel);
  }
  // A file of the last commit that was deleted before the export goes again.
  for (const [root, files] of written) {
    for (const rel of await filesUnder(join(workspace, root), join(workspace, root))) {
      if (!files.has(rel)) await rm(join(workspace, root, rel), { force: true });
    }
  }

  // 3. One commit for the import.
  const paths = [...written.keys()].map((r) => join(workspace, r));
  const message =
    manifest.kind === "workspace"
      ? `Import workspace: ${plan.projects.length} project${plan.projects.length === 1 ? "" : "s"}`
      : `Import project ${plan.projects[0]?.name ?? ""}`.trim();
  try {
    const commit = paths.length && (await Bun.file(join(workspace, ".git", "HEAD")).exists()) ? await commitPaths(workspace, paths, message) : null;
    return { manifest, projects: plan.projects, designSystems: plan.designSystems, history, commit };
  } catch (e) {
    return { manifest, projects: plan.projects, designSystems: plan.designSystems, history, commit: null, commitError: e instanceof Error ? e.message : String(e) };
  }
}

const dec = new TextDecoder();

/**
 * A project file as it must be in this workspace: project.json names the new design system,
 * pages link the design system by its new name, and chat.jsonl names the new commits.
 */
function rewriteProjectFile(
  rel: string,
  data: Uint8Array,
  plan: ImportPlan,
  ids: Map<string, string>,
  project: ImportPlan["projects"][number] | undefined,
): Uint8Array {
  const renamed = plan.designSystems.filter((d) => d.to !== d.from);
  if (rel === "project.json") {
    try {
      const meta = JSON.parse(dec.decode(data)) as Record<string, unknown>;
      const d = renamed.find((x) => x.from === meta.designSystem);
      if (d) meta.designSystem = d.to;
      if (project) meta.name = project.name;
      return utf8.encode(JSON.stringify(meta, null, 2) + "\n");
    } catch {
      return data;
    }
  }
  if (rel === "chat.jsonl" && ids.size) {
    const lines = dec.decode(data).split("\n").map((line) => {
      if (!line.includes('"role":"commit"')) return line;
      try {
        const e = JSON.parse(line) as { role?: string; sha?: string };
        if (e.role === "commit" && e.sha && ids.has(e.sha)) return JSON.stringify({ ...e, sha: ids.get(e.sha) });
      } catch {
        // a bad line stays as it is
      }
      return line;
    });
    return utf8.encode(lines.join("\n"));
  }
  return data;
}

/** Files that can link a design system by its URL: pages, stylesheets, scripts, SVG. */
const LINKS_DS = /\.(html?|css|m?js|svg)$/i;

/**
 * A renamed design system (brand → brand-2) moves to /ds/brand-2/: every page, stylesheet and
 * script of the imported projects and design systems links it there. The version history keeps
 * the old links: an old version restored after such an import links the old name.
 */
function rewriteDsLinks(rel: string, data: Uint8Array, plan: ImportPlan): Uint8Array {
  const renamed = plan.designSystems.filter((d) => d.to !== d.from);
  if (!renamed.length || !LINKS_DS.test(rel)) return data;
  let text = dec.decode(data);
  for (const d of renamed) text = text.split(`/ds/${d.from}/`).join(`/ds/${d.to}/`);
  return utf8.encode(text);
}
