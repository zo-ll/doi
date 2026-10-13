import { mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chatFile, renameInChat } from "./chat.ts";
import { renameLayout, slideLayout, updateProjectMeta, writeLayout } from "./layout.ts";
import { renameVariants } from "./variants.ts";
import { assertName, designDir } from "./paths.ts";
import { projectDir, projectFile } from "./project-file.ts";

/** A workspace error with the HTTP status that fits it. */
export class WorkspaceError extends Error {
  override name = "WorkspaceError";
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

function checkName(kind: string, name: unknown): string {
  if (typeof name !== "string") throw new WorkspaceError(400, `The ${kind} name must be a string.`);
  try {
    assertName(kind, name);
  } catch (e) {
    throw new WorkspaceError(400, (e as Error).message);
  }
  return name;
}

function checkTitle(title: unknown): string {
  const t = typeof title === "string" ? title.trim() : "";
  if (!t || t.length > 80) throw new WorkspaceError(400, "The project name must have 1 to 80 characters.");
  return t;
}

export { projectDir, projectFile };

const STARTER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main data-oid="main"></main>
</body>
</html>
`;
const STARTER_CSS = "body { margin: 0; font-family: system-ui, sans-serif; }\n";

/** A deck starts with one empty slide, so the model sees the slide markup in the files. */
const DECK_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main class="deck" data-oid="deck">
    <section class="slide" data-slide data-oid="slide-1"></section>
  </main>
</body>
</html>
`;
const DECK_CSS = `html { scroll-snap-type: y mandatory; }
body { margin: 0; font-family: system-ui, sans-serif; }
.slide {
  width: 1920px;
  height: 1080px;
  box-sizing: border-box;
  overflow: hidden;
  scroll-snap-align: start;
}
`;

/** A design is a page (screens, one-pagers) or a slide deck. */
export const DESIGN_KINDS = ["page", "slides"] as const;
export type DesignKind = (typeof DESIGN_KINDS)[number];

/** "My Shop!" → "my-shop". The result can still be empty; checkName rejects that. */
export function slugify(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** Creates a project with its first design, "home". Returns the paths to commit. */
export async function createProject(workspace: string, title: unknown, id?: unknown): Promise<{ id: string; paths: string[] }> {
  const name = checkTitle(title);
  const projectId = checkName("project", id ?? slugify(name));
  if (existsSync(projectDir(workspace, projectId))) throw new WorkspaceError(409, `A project "${projectId}" already exists.`);
  await mkdir(join(projectDir(workspace, projectId), "designs"), { recursive: true });
  await Bun.write(projectFile(workspace, projectId), JSON.stringify({ name, designSystem: null, viewports: [1440, 390] }, null, 2) + "\n");
  const { paths } = await createDesign(workspace, projectId, "home");
  return { id: projectId, paths: [projectFile(workspace, projectId), ...paths] };
}

/** Changes the display name in project.json. The folder keeps its id. */
export async function renameProject(workspace: string, project: unknown, title: unknown): Promise<{ paths: string[] }> {
  const id = checkName("project", project);
  const name = checkTitle(title);
  if (!existsSync(projectDir(workspace, id))) throw new WorkspaceError(404, `No project "${id}".`);
  await updateProjectMeta(workspace, id, (meta) => ({ ...meta, name }));
  return { paths: [projectFile(workspace, id)] };
}

/** Creates an empty design in a project. A deck gets one empty slide and the Slide frame. */
export async function createDesign(workspace: string, project: unknown, design: unknown, kind: unknown = "page"): Promise<{ paths: string[] }> {
  const p = checkName("project", project);
  const d = checkName("design", design);
  if (!DESIGN_KINDS.includes(kind as DesignKind)) throw new WorkspaceError(400, `kind must be one of: ${DESIGN_KINDS.join(", ")}.`);
  if (!existsSync(projectDir(workspace, p))) throw new WorkspaceError(404, `No project "${p}".`);
  const dir = designDir(workspace, p, d);
  if (existsSync(dir)) throw new WorkspaceError(409, `A design "${d}" already exists in "${p}".`);
  await mkdir(join(dir, "assets"), { recursive: true });
  const deck = kind === "slides";
  await Bun.write(join(dir, "index.html"), deck ? DECK_HTML : STARTER_HTML);
  await Bun.write(join(dir, "styles.css"), deck ? DECK_CSS : STARTER_CSS);
  if (!deck) return { paths: [dir] };
  await writeLayout(workspace, p, d, slideLayout());
  return { paths: [dir, projectFile(workspace, p)] };
}

/**
 * Moves a design folder and renames it in the project's chat, so its history follows it.
 * The caller must make sure that no turn runs on the design.
 */
export async function renameDesign(workspace: string, project: unknown, from: unknown, to: unknown): Promise<{ paths: string[] }> {
  const p = checkName("project", project);
  const a = checkName("design", from);
  const b = checkName("design", to);
  const src = designDir(workspace, p, a);
  const dst = designDir(workspace, p, b);
  if (!existsSync(src)) throw new WorkspaceError(404, `No design "${a}" in "${p}".`);
  if (a === b) return { paths: [] };
  if (existsSync(dst)) throw new WorkspaceError(409, `A design "${b}" already exists in "${p}".`);
  await rename(src, dst);

  await renameInChat(workspace, p, a, b);
  await renameLayout(workspace, p, a, b);
  const moved = await renameVariants(workspace, p, a, b);
  return { paths: [src, dst, chatFile(workspace, p), projectFile(workspace, p), ...moved] };
}
