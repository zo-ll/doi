import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config, ProviderId } from "../config.ts";
import { ApplyError, runTurn, type TurnEvent } from "../generation/apply.ts";
import { capabilitiesFor } from "../generation/context.ts";
import { EXTRACT_PROMPT } from "../generation/prompts.ts";
import { formatSources, scanRepo } from "../generation/repo-scan.ts";
import type { ContentPart, Provider } from "../providers/types.ts";
import { designSystemDir, designSystemsDir, loadDesignSystem, parseTokens, type Token } from "../workspace/design-systems.ts";
import { updateProjectMeta } from "../workspace/layout.ts";
import { assertName } from "../workspace/paths.ts";
import { projectFile } from "../workspace/project-file.ts";
import { IMAGE_TYPES } from "../workspace/image-limits.ts";
import { parseImages } from "./image-body.ts";
import type { DesignLocks } from "./locks.ts";

export interface ImportDeps {
  config: Config;
  getProvider: (id: ProviderId, config: Config) => Provider;
  locks: DesignLocks;
  /** Commits these paths. Returns the commit id, or null when nothing changed. */
  commit: (paths: string[], message: string) => Promise<string | null>;
}

/** The files of a design system that an import may write. Other files the model writes are dropped. */
export const IMPORT_FILES = ["tokens.css", "components.css", "components.html", "rules.md"] as const;

export type ImportStreamEvent =
  | TurnEvent
  | { type: "sources"; files: string[]; seen: number }
  | { type: "error"; kind: "apply" | "provider" | "result"; message: string }
  | { type: "imported"; name: string; files: string[]; commit: string | null; commitError?: string };

const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const fail = (message: string, status = 400) => Response.json({ error: message }, { status });
const sse = (e: ImportStreamEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/**
 * Runs the extract model on `content` and writes a design system `name`. The model writes into
 * a hidden staging folder; only a result with tokens.css becomes `design-systems/<name>/`.
 * Streams the events. The caller has checked the name and holds the lock `ds:<name>`.
 */
function streamExtraction(
  deps: ImportDeps,
  req: Request,
  provider: Provider,
  name: string,
  content: ContentPart[],
  message: string,
  first: ImportStreamEvent | null,
  unlock: () => void,
  server?: Pick<Bun.Server<unknown>, "timeout">,
  /** Files to keep with the result, for example the screenshots. Written after the model ran. */
  keep: { path: string; data: Uint8Array }[] = [],
): Response {
  const workspace = deps.config.workspace;
  const ref = deps.config.models.extract;
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  req.signal.addEventListener("abort", onAbort);

  const stream = new ReadableStream<string>({
    async start(controller) {
      const send = (e: ImportStreamEvent) => {
        if (!abort.signal.aborted) controller.enqueue(sse(e));
      };
      if (first) send(first);
      const staging = join(designSystemsDir(workspace), `.import-${crypto.randomUUID()}`);
      try {
        await mkdir(staging, { recursive: true });
        const request = {
          model: ref.model,
          system: [EXTRACT_PROMPT.text],
          messages: [{ role: "user" as const, content }],
          signal: abort.signal,
          cwd: staging,
        };
        for await (const e of runTurn(provider, request, { workspace, project: "design-systems", design: name, dir: staging })) {
          send(e);
        }
        // Keep the format: only the known files, and tokens.css is a must.
        for (const entry of await readdir(staging)) {
          if (!(IMPORT_FILES as readonly string[]).includes(entry)) await rm(join(staging, entry), { recursive: true, force: true });
        }
        const files: string[] = IMPORT_FILES.filter((f) => existsSync(join(staging, f)));
        if (!files.includes("tokens.css")) {
          send({ type: "error", kind: "result", message: "The model wrote no tokens.css, so no design system was made. Try again or choose another extract model." });
          return;
        }
        const target = designSystemDir(workspace, name);
        if (existsSync(target)) {
          send({ type: "error", kind: "result", message: `A design system "${name}" was made meanwhile. Nothing was changed.` });
          return;
        }
        for (const k of keep) {
          await Bun.write(join(staging, k.path), k.data);
          files.push(k.path);
        }
        await rename(staging, target);
        try {
          send({ type: "imported", name, files, commit: await deps.commit([target], message) });
        } catch (e) {
          send({ type: "imported", name, files, commit: null, commitError: e instanceof Error ? e.message : String(e) });
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          send({ type: "error", kind: e instanceof ApplyError ? "apply" : "provider", message: e instanceof Error ? e.message : String(e) });
        }
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
        unlock();
        req.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // Already closed by a cancel.
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
  server?.timeout(req, 0);
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

/** The extract model's provider, or an error. Images need a model with vision. */
function extractProvider(deps: ImportDeps, images: boolean): Provider | Response {
  const ref = deps.config.models.extract;
  let provider: Provider;
  try {
    provider = deps.getProvider(ref.provider, deps.config);
  } catch (e) {
    return fail((e as Error).message);
  }
  if (images && !capabilitiesFor(provider, ref.model).vision) {
    return fail(`${ref.provider}:${ref.model} cannot read images. Choose an extract model with vision in Settings, Models and providers.`);
  }
  return provider;
}

/** Checks a new design system name and takes its lock. Returns the unlock function, or an error. */
function claim(deps: ImportDeps, name: unknown): (() => void) | Response {
  if (typeof name !== "string" || !NAME.test(name)) return fail('name must use a-z, 0-9 and "-" (at most 60 characters).');
  if (existsSync(designSystemDir(deps.config.workspace, name))) return fail(`A design system "${name}" already exists.`, 409);
  const key = `ds:${name}`;
  if (!deps.locks.tryLock(key)) return fail(`An import of "${name}" is already running.`, 409);
  return () => deps.locks.unlock(key);
}

/**
 * POST /api/design-systems/import { name, repo }: reads design files from a local repo and
 * writes a design system with the extract model. The repo is only read, never written.
 */
export async function importFromRepo(deps: ImportDeps, req: Request, server?: Pick<Bun.Server<unknown>, "timeout">): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
  } catch {
    return fail("The body must be a JSON object.");
  }
  const { name, repo } = body;
  if (typeof repo !== "string" || !isAbsolute(repo)) return fail("repo must be an absolute path to a folder.");
  const root = resolve(repo);
  // The workspace is doi's own data, not a product repo.
  const workspace = resolve(deps.config.workspace);
  if (root === workspace || root.startsWith(workspace + "/")) return fail("repo must be outside the doi workspace.");

  const provider = extractProvider(deps, false);
  if (provider instanceof Response) return provider;
  const unlock = claim(deps, name);
  if (unlock instanceof Response) return unlock;
  let scan;
  try {
    scan = await scanRepo(root);
  } catch (e) {
    unlock();
    return fail(e instanceof Error && /ENOENT|ENOTDIR|not a folder/.test(e.message) ? "The repo path is not a folder." : String(e));
  }
  if (!scan.sources.length) {
    unlock();
    return fail("No design files were found in this repo: no Tailwind config, theme files, stylesheets with tokens or components.");
  }
  return streamExtraction(
    deps,
    req,
    provider,
    name as string,
    [{ type: "text", text: formatSources(basename(root), scan.sources) }],
    `Import design system ${name} from ${basename(root)}`,
    { type: "sources", files: scan.sources.map((s) => s.path), seen: scan.seen },
    unlock,
    server,
  );
}

const MAX_NOTES = 2000;

/**
 * POST /api/design-systems/import-screenshots { name, images, notes? }: reads colors, type,
 * spacing and components from screenshots with the extract model (it needs vision). The
 * screenshots are kept in the design system's screenshots/ folder.
 */
export async function importFromScreenshots(deps: ImportDeps, req: Request, server?: Pick<Bun.Server<unknown>, "timeout">): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
  } catch {
    return fail("The body must be a JSON object.");
  }
  const { name, notes = "" } = body;
  const images = parseImages(body.images);
  if (typeof images === "string") return fail(images);
  if (!images.length) return fail("Add at least one screenshot.");
  if (typeof notes !== "string" || notes.length > MAX_NOTES) return fail(`notes must be text of at most ${MAX_NOTES} characters.`);
  const provider = extractProvider(deps, true);
  if (provider instanceof Response) return provider;
  const unlock = claim(deps, name);
  if (unlock instanceof Response) return unlock;

  const text =
    `Make a design system from these ${images.length === 1 ? "screenshot" : `${images.length} screenshots`} of one product. ` +
    "Read colors, type, spacing, radius, shadows and the look of the components from them. " +
    "A screenshot does not show exact values: choose the nearest round values, and say in tokens.css which ones you estimated." +
    (notes.trim() ? `\n\nNotes from the user:\n${notes.trim()}` : "");
  const keep = images.map((img, i) => ({ path: `screenshots/screenshot-${i + 1}.${IMAGE_TYPES[img.mediaType]}`, data: img.data }));
  return streamExtraction(
    deps,
    req,
    provider,
    name as string,
    [{ type: "text", text }, ...images.map((img) => ({ type: "image" as const, mediaType: img.mediaType, data: img.data }))],
    `Import design system ${name} from ${images.length === 1 ? "a screenshot" : `${images.length} screenshots`}`,
    null,
    unlock,
    server,
    keep,
  );
}

export { claim, extractProvider, streamExtraction };

/** A design system as the UI shows it. */
export interface DesignSystemView {
  name: string;
  /** The folder on disk, for "open in the editor". */
  dir: string;
  /** The files of the design system, as paths in its folder. */
  files: string[];
  tokens: Token[];
  fonts: string[];
  screenshots: string[];
  rules: string | null;
  hasComponents: boolean;
}

/** GET /api/design-systems/:name */
export async function getDesignSystem(workspace: string, name: string): Promise<Response> {
  let ds;
  try {
    ds = await loadDesignSystem(workspace, name);
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!ds) return fail("Design system not found.", 404);
  const dir = designSystemDir(workspace, name);
  const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"))
    .filter((p) => !p.split("/").some((part) => part.startsWith(".")))
    .sort();
  return Response.json({
    name,
    dir,
    files,
    tokens: ds.tokens ? parseTokens(ds.tokens) : [],
    fonts: ds.fonts,
    screenshots: ds.screenshots,
    rules: ds.rules,
    hasComponents: ds.components !== null,
  } satisfies DesignSystemView);
}

/**
 * PUT /api/projects/:project/design-system { name }: the design system of a project, or null
 * for none. The next turn uses it; the change is a commit of project.json.
 */
export async function putProjectDesignSystem(
  deps: Pick<ImportDeps, "config" | "commit">,
  req: Request,
  params: { project: string },
): Promise<Response> {
  const workspace = deps.config.workspace;
  try {
    assertName("project", params.project);
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!existsSync(projectFile(workspace, params.project))) return fail("Project not found.", 404);
  let name: unknown;
  try {
    name = ((await req.json()) as { name?: unknown }).name;
  } catch {
    return fail("The body must be JSON.");
  }
  if (name !== null && (typeof name !== "string" || !NAME.test(name))) return fail("name must be a design system name or null.");
  if (name !== null && !(await loadDesignSystem(workspace, name as string))) return fail(`No design system "${name}".`, 404);
  await updateProjectMeta(workspace, params.project, (meta) => ({ ...meta, designSystem: name }));
  try {
    const commit = await deps.commit([projectFile(workspace, params.project)], name ? `Use design system ${name}` : "Use no design system");
    return Response.json({ name, commit });
  } catch (e) {
    return Response.json({ name, commit: null, commitError: e instanceof Error ? e.message : String(e) });
  }
}
