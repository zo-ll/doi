import { DEFAULT_KEY_ENV, parseModelChoice, PROVIDERS, withModels, type Config, type ModelRef, type ModelTask, type ProviderId } from "../config.ts";
import { capabilitiesFor } from "../generation/context.ts";
import { checkKey, keyStore, type KeyStore } from "../providers/keys.ts";
import { defaultLoginDeps, LOGIN_COMMANDS, startLogin, type LoginDeps } from "../providers/login.ts";
import { defaultModelListDeps, listModels, type ModelListDeps } from "../providers/models.ts";
import { getProvider } from "../providers/registry.ts";
import { usageEntries, type UsageEntry } from "../workspace/chat.ts";
import { listProjects } from "../workspace/paths.ts";

const TASKS: readonly ModelTask[] = ["generate", "edit", "extract"];
const fail = (message: string, status = 400) => Response.json({ error: message }, { status });

/** Whether the model can read images; null when doi has no adapter for its provider. */
export function visionOf(config: Config, ref: ModelRef): boolean | null {
  try {
    return capabilitiesFor(getProvider(ref.provider, config), ref.model).vision;
  } catch {
    return null;
  }
}

/** What the UI may know of the config: no provider settings, no key names. */
export function configView(config: Config) {
  return {
    models: config.models,
    /** Per task: whether its model can read images (the same check as a turn and the screenshot import). */
    vision: Object.fromEntries(TASKS.map((t) => [t, visionOf(config, config.models[t])])) as Record<ModelTask, boolean | null>,
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
  // The turn and import routes read config.models at each request.
  Object.assign(config.models, next);
  return Response.json(configView(config));
}

/** GET /api/usage: the token use of every stored answer, all projects. The UI sums it. */
export async function getUsage(config: Config): Promise<Response> {
  const projects = await listProjects(config.workspace);
  const entries: UsageEntry[] = (await Promise.all(projects.map((p) => usageEntries(config.workspace, p.id)))).flat();
  return Response.json(entries);
}

/** Providers that take an API key. */
function keyProvider(raw: string | undefined): ProviderId | null {
  return PROVIDERS.includes(raw as ProviderId) && DEFAULT_KEY_ENV[raw as ProviderId] ? (raw as ProviderId) : null;
}

/**
 * PUT /api/providers/:id/key { key }: stores the key in the system keychain (else the 0600 file).
 * The answer says where, never the key.
 */
export async function putProviderKey(req: Request, params: { id: string }, keys: KeyStore = keyStore()): Promise<Response> {
  const id = keyProvider(params.id);
  if (!id) return fail("This provider does not take an API key.", 404);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("The body must be a JSON object.");
  }
  const key = checkKey((body as { key?: unknown } | null)?.key);
  if (!key) return fail("The key must be one line of visible characters, 4096 at most.");
  try {
    return Response.json({ where: await keys.set(id, key) });
  } catch (e) {
    return fail(`The key could not be stored: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
}

/** DELETE /api/providers/:id/key: removes the stored key. An environment variable stays. */
export async function deleteProviderKey(params: { id: string }, keys: KeyStore = keyStore()): Promise<Response> {
  const id = keyProvider(params.id);
  if (!id) return fail("This provider does not take an API key.", 404);
  try {
    return Response.json({ removed: await keys.delete(id) });
  } catch (e) {
    return fail(`The key could not be removed: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
}

/** POST /api/providers/:id/login: starts the official CLI login (OAuth in the browser). */
export async function postProviderLogin(params: { id: string }, deps: LoginDeps = defaultLoginDeps): Promise<Response> {
  const id = params.id as ProviderId;
  if (!PROVIDERS.includes(id) || !LOGIN_COMMANDS[id]) return fail("This provider has no OAuth login.", 404);
  const result = await startLogin(id, deps);
  return result.ok ? Response.json({ url: result.url }) : fail(result.error, 502);
}

/** GET /api/providers/:id/models: the model ids of a provider. The key stays on the server. */
export async function getProviderModels(config: Config, params: { id: string }, deps: ModelListDeps = defaultModelListDeps): Promise<Response> {
  const id = params.id as ProviderId;
  if (!PROVIDERS.includes(id)) return fail("Unknown provider.", 404);
  const list = await listModels(id, config, deps);
  return list.ok ? Response.json({ models: list.models, fixed: list.fixed }) : fail(list.error, 502);
}
