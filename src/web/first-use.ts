/**
 * First-use logic without React: when the flow shows, the workspace-scoped completion record, the
 * vendor and method it opens with, and the checks before a model choice is saved.
 *
 * A consumer reads `showFirstUse()` with the three facts it has (the URL asks for the flow, the URL
 * links one design, this workspace is done) and renders the flow or the editor.
 */
import type { ProviderStatus } from "./api.ts";
import { defaultMethod, methodsOf, validModelId, VENDORS, vendorOf, type AuthMethod, type Vendor } from "./providers.ts";

/** The query parameter of the comparison URL: `/?setup=1` always shows the flow. */
export const SETUP_PARAM = "setup";
/** The vendors of the flow; other providers stay in Settings. */
export const SETUP_VENDOR_IDS = ["anthropic", "openai", "opencode-go"] as const;
/** The storage key prefix; one record per workspace folder. */
export const SETUP_KEY = "doi:first-use";

export interface SetupRecord {
  done: true;
  /** "saved": a provider and model were saved. "skip": Explore without a model. */
  mode: "saved" | "skip";
  /** When, as an ISO date. */
  at: string;
}

/** The part of localStorage that the record needs. Tests use a map with the same shape. */
export type SetupStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * localStorage, or null when this browser blocks it (a private window, blocked site data).
 * The probe makes the check real: some browsers give a store that throws on the first write.
 */
export function browserStorage(): SetupStore | null {
  try {
    const store = globalThis.localStorage;
    const probe = `${SETUP_KEY}:probe`;
    store.setItem(probe, "1");
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

/** The completion record of one workspace. Another workspace folder keeps its own. */
export function setupKey(workspace: string): string {
  return `${SETUP_KEY}:${workspace}`;
}

export function readSetup(store: SetupStore | null, workspace: string): SetupRecord | null {
  if (!store) return null;
  try {
    const raw = store.getItem(setupKey(workspace));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SetupRecord> | null;
    if (value?.done !== true || (value.mode !== "saved" && value.mode !== "skip")) return null;
    return { done: true, mode: value.mode, at: typeof value.at === "string" ? value.at : "" };
  } catch {
    return null;
  }
}

/** Writes the record. False when the browser refuses storage; the flow still opens this time. */
export function writeSetup(store: SetupStore | null, workspace: string, record: SetupRecord): boolean {
  if (!store) return false;
  try {
    store.setItem(setupKey(workspace), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** True when the address bar asks for the flow: `?setup=1`. */
export function setupInUrl(search: string): boolean {
  return new URLSearchParams(search).get(SETUP_PARAM) === "1";
}

/** The search string without `setup`, so the flow is not shown again after it is done. */
export function withoutSetup(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(SETUP_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

export interface Gate {
  /** `?setup=1` is in the address bar, or Settings reopened the flow. */
  requested: boolean;
  /** The address bar links one design or node of this workspace. */
  deepLink: boolean;
  /** This workspace finished the flow, or chose Explore without a model. */
  completed: boolean;
}

/** The flow shows once per workspace; a requested flow always shows; a design link wins. */
export function showFirstUse(gate: Gate): boolean {
  return gate.requested || (!gate.deepLink && !gate.completed);
}

/** A design link opens its target, as long as that project and design are in the workspace. */
export function isDeepLink(
  link: { project: string; design: string } | null,
  projects: { id: string; designs: string[] }[],
): boolean {
  return !!link && projects.some((p) => p.id === link.project && p.designs.includes(link.design));
}

/** The vendors of the flow, with only the methods that doi implements. */
export function setupVendors(statuses: ProviderStatus[]): Vendor[] {
  const implemented = new Set(statuses.filter((p) => p.implemented).map((p) => p.id));
  return VENDORS.filter((v) => (SETUP_VENDOR_IDS as readonly string[]).includes(v.id))
    .map((v): Vendor => ({
      ...v,
      methods: Object.fromEntries(Object.entries(v.methods).filter(([, id]) => implemented.has(id as ProviderStatus["id"]))) as Vendor["methods"],
    }))
    .filter((v) => methodsOf(v).length > 0);
}

/** The provider behind a method, "" when the vendor does not have that method. */
export function methodProvider(vendor: Vendor, method: AuthMethod): string {
  return vendor.methods[method] ?? "";
}

/** The status of a method's provider: the CLI login, the API key, or the local server. */
export function methodStatus(statuses: ProviderStatus[], vendor: Vendor, method: AuthMethod): ProviderStatus | undefined {
  const id = methodProvider(vendor, method);
  return id ? statuses.find((p) => p.id === id) : undefined;
}

/** A method can be chosen when doi implements it; it can continue when it is ready too. */
export function methodReady(statuses: ProviderStatus[], vendor: Vendor, method: AuthMethod): boolean {
  const p = methodStatus(statuses, vendor, method);
  return !!p && p.implemented && p.ready;
}

/**
 * The method a vendor opens with: the one of `preferred` when it is ready, else any ready method,
 * else the preferred one (so its own status and fix show), else the first method.
 */
export function methodFor(vendor: Vendor, statuses: ProviderStatus[], preferred?: string): AuthMethod {
  const all = methodsOf(vendor);
  const wanted = all.find((m) => vendor.methods[m] === preferred);
  if (wanted && methodReady(statuses, vendor, wanted)) return wanted;
  const ready = all.find((m) => methodReady(statuses, vendor, m));
  if (ready) return ready;
  return wanted ?? defaultMethod(vendor, statuses);
}

export interface SetupStart {
  vendorId: string;
  method: AuthMethod;
  /** The configured model when the configured provider is the one behind the method, else "". */
  model: string;
}

/** What the flow shows first: the vendor of the generate model, with a ready method fallback. */
export function startChoice(generate: { provider: string; model: string }, statuses: ProviderStatus[]): SetupStart {
  const vendors = setupVendors(statuses);
  const configured = vendorOf(generate.provider);
  const vendor = vendors.find((v) => v.id === configured.id) ?? vendors[0] ?? configured;
  const method = methodFor(vendor, statuses, generate.provider);
  const provider = methodProvider(vendor, method);
  const model = provider === generate.provider ? generate.model : "";
  return { vendorId: vendor.id, method, model };
}

/** The model for a provider: the person's kept choice, else the configured one, else the first. */
export function pickModel(
  kept: string | null | undefined,
  configured: { provider: string; model: string },
  provider: string,
  catalog: string[],
): string {
  if (kept) return kept;
  if (configured.provider === provider && validModelId(configured.model)) return configured.model;
  return catalog[0] ?? "";
}

/** The body of PUT /api/config/models: one provider and model for generate, edit and extract. */
export function modelSaveBody(provider: string, model: string): Record<"generate" | "edit" | "extract", string> {
  const ref = `${provider}:${model.trim()}`;
  return { generate: ref, edit: ref, extract: ref };
}

/** How a connection method reads on the screen: the subscription name, or the key. */
export const OAUTH_NAME: Record<string, string> = {
  anthropic: "Claude subscription",
  openai: "ChatGPT subscription",
};
export const OAUTH_CLI: Record<string, string> = {
  anthropic: "Claude Code CLI",
  openai: "Codex CLI",
};

/** The title of the current method, for the method box and the ready summary. */
export function methodName(vendor: Vendor, method: AuthMethod): string {
  if (method === "oauth") return OAUTH_NAME[vendor.id] ?? (vendor.oauthLabel?.split(" · ")[0] || "Subscription");
  if (method === "local") return "Local server";
  return "API key";
}

/** The small tag after the method name: the official CLI, or the provider's API. */
export function methodTag(vendor: Vendor, method: AuthMethod): string {
  if (method === "oauth") return OAUTH_CLI[vendor.id] ?? (vendor.oauthLabel?.split(" · ")[1] || "Official CLI");
  if (method === "local") return vendor.methods.local ?? "";
  return vendor.name;
}

/** The line under the provider name on the model and ready steps. */
export function methodSummary(vendor: Vendor, method: AuthMethod): string {
  return method === "oauth" ? `${methodName(vendor, method)} · ${methodTag(vendor, method)}` : methodName(vendor, method);
}

/**
 * Why Continue is off, in the words of the selected method. Null when the method can continue.
 * A missing CLI, a login, a key and a failed check each get their own action.
 */
export function methodBlocker(statuses: ProviderStatus[], vendor: Vendor, method: AuthMethod): string | null {
  const provider = methodProvider(vendor, method);
  if (!provider) return "doi does not connect this provider yet.";
  const p = statuses.find((x) => x.id === provider);
  if (!p) return "Checking the provider status…";
  if (!p.implemented) return "doi has no adapter for this provider yet.";
  if (p.ready) return null;
  if (/not found/i.test(p.detail)) return `The ${methodTag(vendor, method)} is not installed. Install it, then check again.`;
  if (method === "oauth") return p.detail || "Not logged in. Log in with the official CLI, then check again.";
  if (method === "local") return p.detail || "The local server does not answer. Start it, then check again.";
  return p.detail || "Add an API key to continue.";
}

/** The model ids for the model step: the provider catalog, with the configured model when it is not listed. */
export function modelOptions(catalog: string[], configured: { provider: string; model: string }, provider: string): string[] {
  const ids = catalog.filter((id) => validModelId(id));
  if (configured.provider !== provider || !configured.model || !validModelId(configured.model) || ids.includes(configured.model)) return ids;
  return [configured.model, ...ids];
}

/** The model step continues only with a ready provider and a valid id. */
export function canSaveModel(statuses: ProviderStatus[], provider: string, model: string): boolean {
  if (!validModelId(model)) return false;
  const p = statuses.find((x) => x.id === provider);
  return !!p && p.implemented && p.ready;
}
