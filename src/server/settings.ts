import { parseModelChoice, withModels, type Config, type ModelRef, type ModelTask } from "../config.ts";
import { usageEntries, type UsageEntry } from "../workspace/chat.ts";
import { listProjects } from "../workspace/paths.ts";

const TASKS: readonly ModelTask[] = ["generate", "edit", "extract"];
const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

/** What the UI may know of the config: no provider settings, no key names. */
export function configView(config: Config) {
  return {
    models: config.models,
    workspace: config.workspace,
    editorUrl: config.editorUrl,
    prices: config.prices,
    configPath: config.configPath,
  };
}

/**
 * PUT /api/config/models { generate, edit, extract }: each "<provider>:<model>". Writes them to
 * config.toml (only the [models] lines) and uses them at once.
 */
export async function putModels(config: Config, req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("The body must be a JSON object.");
  }
  if (typeof body !== "object" || body === null) return fail("The body must be a JSON object.");
  const next = {} as Record<ModelTask, ModelRef>;
  for (const task of TASKS) {
    const ref = parseModelChoice((body as Record<string, unknown>)[task]);
    if (typeof ref === "string") return fail(`${task}: ${ref}`);
    next[task] = ref;
  }
  if (config.configPath) {
    const file = Bun.file(config.configPath);
    const text = (await file.exists()) ? await file.text() : "";
    try {
      await Bun.write(config.configPath, withModels(text, next));
    } catch (e) {
      return fail(`config.toml could not be written: ${e instanceof Error ? e.message : String(e)}`, 500);
    }
  }
  // The turn, variant and import routes read config.models at each request.
  Object.assign(config.models, next);
  return Response.json(configView(config));
}

/** GET /api/usage: the token use of every stored answer, all projects. The UI sums it. */
export async function getUsage(config: Config): Promise<Response> {
  const projects = await listProjects(config.workspace);
  const entries: UsageEntry[] = (await Promise.all(projects.map((p) => usageEntries(config.workspace, p.id)))).flat();
  return Response.json(entries);
}
