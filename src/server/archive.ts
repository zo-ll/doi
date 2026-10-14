import { parseModelChoice, withModels, withPrices, type Config, type ModelRef, type ModelTask } from "../config.ts";
import { ArchiveError, exportArchive, importArchive, planImport, type ArchiveSettings, type UiPrefs } from "../workspace/archive.ts";
import type { DesignLocks } from "./locks.ts";

export interface ArchiveDeps {
  config: Config;
  locks: DesignLocks;
}

const fail = (message: string, status = 400) => Response.json({ error: message }, { status });
/** The largest import file the server reads. */
export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const TASKS: readonly ModelTask[] = ["generate", "edit", "extract"];
const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;

function uiPrefs(raw: unknown): UiPrefs | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const p = r.panels as Record<string, unknown> | null;
  const l = r.lastDesign as Record<string, unknown> | null;
  return {
    theme: r.theme === "light" || r.theme === "dark" ? r.theme : null,
    panels: p && typeof p.chat === "boolean" && typeof p.side === "boolean" ? { chat: p.chat, side: p.side } : null,
    lastDesign: l && typeof l.project === "string" && NAME.test(l.project) && typeof l.design === "string" && NAME.test(l.design) ? { project: l.project, design: l.design } : null,
  };
}

/** POST /api/export { kind, project?, settings?, ui? }: the export file as a download. */
export async function postExport(deps: ArchiveDeps, req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("The body must be a JSON object.");
  }
  const kind = body.kind;
  if (kind !== "project" && kind !== "workspace") return fail('kind must be "project" or "workspace".');
  if (kind === "project" && (typeof body.project !== "string" || !NAME.test(body.project))) return fail("project must be a project id.");
  const settings: ArchiveSettings | null = body.settings
    ? {
        models: Object.fromEntries(TASKS.map((t) => [t, `${deps.config.models[t].provider}:${deps.config.models[t].model}`])) as ArchiveSettings["models"],
        prices: deps.config.prices,
      }
    : null;
  try {
    const { bytes, manifest } = await exportArchive(deps.config.workspace, {
      kind,
      ...(kind === "project" ? { projects: [body.project as string] } : {}),
      settings,
      ui: uiPrefs(body.ui),
    });
    const day = manifest.createdAt.slice(0, 10);
    const file = kind === "project" ? `${body.project}-${day}.doi.zip` : `doi-workspace-${day}.doi.zip`;
    return new Response(bytes, {
      headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${file}"`, "cache-control": "no-store" },
    });
  } catch (e) {
    if (e instanceof ArchiveError) return fail(e.message, e.status);
    throw e;
  }
}

async function readBody(req: Request): Promise<Uint8Array | Response> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_IMPORT_BYTES) return fail("The file is larger than 512 MB.", 413);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length) return fail("The body is empty: send the export file.");
  if (bytes.length > MAX_IMPORT_BYTES) return fail("The file is larger than 512 MB.", 413);
  return bytes;
}

/** POST /api/import/inspect (a ZIP body): what the file holds and what an import would do. Writes nothing. */
export async function postImportInspect(deps: ArchiveDeps, req: Request): Promise<Response> {
  const bytes = await readBody(req);
  if (bytes instanceof Response) return bytes;
  try {
    const { manifest, projects, designSystems } = await planImport(deps.config.workspace, bytes);
    return Response.json({ manifest, projects, designSystems });
  } catch (e) {
    if (e instanceof ArchiveError) return fail(e.message, e.status);
    throw e;
  }
}

/**
 * POST /api/import?settings=1 (a ZIP body): imports the file. With `settings=1`, the model
 * choice and the prices of the file go into config.toml and the running config too.
 */
export async function postImport(deps: ArchiveDeps, req: Request): Promise<Response> {
  const bytes = await readBody(req);
  if (bytes instanceof Response) return bytes;
  const applySettings = new URL(req.url).searchParams.get("settings") === "1";
  if (!deps.locks.tryLock("import")) return fail("An import runs now. Try again when it ends.", 409);
  try {
    const result = await importArchive(deps.config.workspace, bytes);
    let settingsApplied = false;
    let settingsError: string | undefined;
    const s = result.manifest.settings;
    if (applySettings && s) {
      try {
        const models = {} as Record<ModelTask, ModelRef>;
        for (const t of TASKS) {
          const ref = parseModelChoice(s.models?.[t]);
          if (typeof ref === "string") throw new Error(`${t}: ${ref}`);
          models[t] = ref;
        }
        const prices = parseConfigPrices(s.prices);
        if (deps.config.configPath) {
          const file = Bun.file(deps.config.configPath);
          const text = (await file.exists()) ? await file.text() : "";
          await Bun.write(deps.config.configPath, withPrices(withModels(text, models), prices));
        }
        Object.assign(deps.config.models, models);
        deps.config.prices = prices;
        settingsApplied = true;
      } catch (e) {
        settingsError = e instanceof Error ? e.message : String(e);
      }
    }
    return Response.json({ ...result, settingsApplied, ...(settingsError ? { settingsError } : {}) });
  } catch (e) {
    if (e instanceof ArchiveError) return fail(e.message, e.status);
    throw e;
  } finally {
    deps.locks.unlock("import");
  }
}

/** The prices of a file, checked as config.toml prices are. */
function parseConfigPrices(raw: unknown): Config["prices"] {
  const out: Config["prices"] = {};
  if (typeof raw !== "object" || raw === null) return out;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  for (const [ref, p] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    if (typeof parseModelChoice(ref) === "string") continue;
    const input = num(p?.input);
    const output = num(p?.output);
    if (input === undefined || output === undefined) continue;
    const cached = num(p?.cached);
    out[ref] = { input, output, ...(cached !== undefined ? { cached } : {}) };
  }
  return out;
}
