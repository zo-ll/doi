import { mkdir, readdir } from "node:fs/promises";
import { join, normalize, relative, sep } from "node:path";

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export function assertName(kind: string, name: string): void {
  if (!NAME.test(name)) throw new Error(`Invalid ${kind} name "${name}". Use a-z, 0-9 and "-".`);
}

export function designDir(workspace: string, project: string, design: string): string {
  assertName("project", project);
  assertName("design", design);
  return join(workspace, "projects", project, "designs", design);
}

/** Resolves a file inside a design folder. Returns null for paths that leave the folder. */
export function designFile(workspace: string, project: string, design: string, file: string): string | null {
  return fileIn(designDir(workspace, project, design), file);
}

/** Resolves a file inside `dir`. Returns null for paths that leave it. */
export function fileIn(dir: string, file: string): string | null {
  const full = normalize(join(dir, file));
  return full.startsWith(dir + sep) ? full : null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  designs: string[];
  /** The designs that are slide decks: their index.html marks slides with data-slide (#48). */
  decks: string[];
  /** The selected design system, or null. */
  designSystem: string | null;
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && NAME.test(e.name)).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

const SLIDE = /\bdata-slide(?![\w-])/;

/** The HTML pages of a design, index.html first, then by path. Hidden files and folders do not count. */
export async function designPages(workspace: string, project: string, design: string): Promise<string[]> {
  const dir = designDir(workspace, project, design);
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const pages = entries
    .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"))
    .filter((p) => !p.split("/").some((part) => part.startsWith(".")));
  return pages.sort((a, b) => Number(b === "index.html") - Number(a === "index.html") || a.localeCompare(b));
}

/** Lists projects and their designs. A design is a folder with an index.html. */
export async function listProjects(workspace: string): Promise<ProjectSummary[]> {
  const projects: ProjectSummary[] = [];
  for (const id of await subdirs(join(workspace, "projects"))) {
    const meta = Bun.file(join(workspace, "projects", id, "project.json"));
    let name = id;
    let designSystem: string | null = null;
    try {
      if (await meta.exists()) {
        const data = await meta.json();
        name = String(data.name ?? id);
        if (typeof data.designSystem === "string" && NAME.test(data.designSystem)) designSystem = data.designSystem;
      }
    } catch {
      // A hand-edited project.json with bad JSON must not hide the other projects.
    }
    const designs: string[] = [];
    const decks: string[] = [];
    for (const design of await subdirs(join(workspace, "projects", id, "designs"))) {
      const index = Bun.file(join(designDir(workspace, id, design), "index.html"));
      if (!(await index.exists())) continue;
      designs.push(design);
      if (SLIDE.test(await index.text())) decks.push(design);
    }
    projects.push({ id, name, designs, decks, designSystem });
  }
  return projects;
}

const SAMPLE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main data-oid="main">
    <h1 data-oid="title">Hello from doi</h1>
    <p data-oid="lead">Click an element to select it.</p>
    <button data-oid="cta">Primary action</button>
  </main>
</body>
</html>
`;

const SAMPLE_CSS = `:root { --space-unit: 8px; --accent: #3b5bdb; }
body { font-family: system-ui, sans-serif; margin: 0; }
main { padding: calc(var(--space-unit) * 6); display: grid; gap: calc(var(--space-unit) * 2); max-width: 40rem; }
button { justify-self: start; padding: var(--space-unit) calc(var(--space-unit) * 2); border: 0; border-radius: 6px; background: var(--accent); color: white; }
`;

/** Creates the workspace layout and a sample design on first run. */
export async function ensureWorkspace(workspace: string): Promise<void> {
  await mkdir(join(workspace, "design-systems"), { recursive: true });
  const dir = designDir(workspace, "sample", "home");
  const index = Bun.file(join(dir, "index.html"));
  if (await index.exists()) return;
  await mkdir(join(dir, "assets"), { recursive: true });
  await Bun.write(index, SAMPLE_HTML);
  await Bun.write(join(dir, "styles.css"), SAMPLE_CSS);
  await Bun.write(
    join(workspace, "projects", "sample", "project.json"),
    JSON.stringify({ name: "Sample", designSystem: null, viewports: [1440, 390] }, null, 2) + "\n",
  );
}
