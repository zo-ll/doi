import { describe, expect, test } from "bun:test";
import type { ProviderStatus } from "../src/providers/status.ts";
import {
  browserStorage,
  canSaveModel,
  isDeepLink,
  methodBlocker,
  methodFor,
  methodName,
  methodProvider,
  methodReady,
  methodSummary,
  methodTag,
  modelOptions,
  modelSaveBody,
  pickModel,
  readSetup,
  SETUP_KEY,
  setupInUrl,
  setupKey,
  setupVendors,
  showFirstUse,
  startChoice,
  withoutSetup,
  writeSetup,
  type SetupStore,
} from "../src/web/first-use.ts";
import { defaultMethod, VENDORS, vendorOf } from "../src/web/providers.ts";

const status = (over: Partial<ProviderStatus> & { id: ProviderStatus["id"] }): ProviderStatus => ({
  source: "cli",
  ready: true,
  detail: "Logged in",
  implemented: true,
  ...over,
});
const codex = status({ id: "codex" });
const claude = status({ id: "claude-code" });
const anthropic = status({ id: "anthropic", source: "api_key", ready: false, detail: "No API key." });
const openai = status({ id: "openai", source: "api_key", ready: false, detail: "No API key." });
const opencode = status({ id: "opencode-go", source: "api_key", ready: false, detail: "No API key." });
const all = [codex, claude, anthropic, openai, opencode];

/** A map with the Storage methods that the record uses. */
function store(initial: Record<string, string> = {}, fail = false) {
  const map = new Map(Object.entries(initial));
  const s: SetupStore & { map: Map<string, string> } = {
    map,
    getItem: (k) => (fail ? (() => { throw new Error("blocked"); })() : (map.get(k) ?? null)),
    setItem: (k, v) => (fail ? (() => { throw new Error("blocked"); })() : void map.set(k, v)),
    removeItem: (k) => (fail ? (() => { throw new Error("blocked"); })() : void map.delete(k)),
  };
  return s;
}

describe("when the first-use flow shows", () => {
  test("once per workspace, unless a design link opens its target or a request asks for it", () => {
    expect(showFirstUse({ requested: false, deepLink: false, completed: false })).toBe(true);
    expect(showFirstUse({ requested: false, deepLink: false, completed: true })).toBe(false);
    expect(showFirstUse({ requested: true, deepLink: false, completed: true })).toBe(true);
    expect(showFirstUse({ requested: false, deepLink: true, completed: false })).toBe(false);
    expect(showFirstUse({ requested: false, deepLink: true, completed: true })).toBe(false);
    // A direct `?setup=1` for comparison wins over a deep link.
    expect(showFirstUse({ requested: true, deepLink: true, completed: true })).toBe(true);
  });

  test("a link counts only when its project and design are in the workspace", () => {
    const projects = [{ id: "shop", designs: ["home", "about"] }];
    expect(isDeepLink({ project: "shop", design: "home" }, projects)).toBe(true);
    expect(isDeepLink({ project: "shop", design: "gone" }, projects)).toBe(false);
    expect(isDeepLink({ project: "other", design: "home" }, projects)).toBe(false);
    expect(isDeepLink(null, projects)).toBe(false);
  });

  test("the URL request keeps other link parts and leaves the URL clean after the flow", () => {
    expect(setupInUrl("?setup=1")).toBe(true);
    expect(setupInUrl("?project=shop&design=home")).toBe(false);
    expect(setupInUrl("?setup=0")).toBe(false);
    expect(withoutSetup("?setup=1")).toBe("");
    expect(withoutSetup("?setup=1&project=shop&design=home")).toBe("?project=shop&design=home");
    expect(withoutSetup("?project=shop&design=home")).toBe("?project=shop&design=home");
  });
});

describe("the workspace-scoped completion record", () => {
  test("a saved record is per workspace folder and survives a reload", () => {
    const s = store();
    expect(readSetup(s, "/work/a")).toBeNull();
    expect(writeSetup(s, "/work/a", { done: true, mode: "saved", at: "2026-11-03T10:00:00.000Z" })).toBe(true);
    expect(readSetup(s, "/work/a")).toEqual({ done: true, mode: "saved", at: "2026-11-03T10:00:00.000Z" });
    expect(readSetup(s, "/work/b")).toBeNull();
    expect(s.map.has(setupKey("/work/a"))).toBe(true);
    expect(s.map.has(SETUP_KEY)).toBe(false);
  });

  test("a skipped flow is a completion too", () => {
    const s = store();
    writeSetup(s, "/work/a", { done: true, mode: "skip", at: "" });
    expect(readSetup(s, "/work/a")).toEqual({ done: true, mode: "skip", at: "" });
  });

  test("bad or blocked storage reads as not completed and still closes this time", () => {
    expect(readSetup(null, "/work/a")).toBeNull();
    expect(writeSetup(null, "/work/a", { done: true, mode: "skip", at: "" })).toBe(false);
    const broken = store({ [setupKey("/work/a")]: "{not json" });
    expect(readSetup(broken, "/work/a")).toBeNull();
    const wrong = store({ [setupKey("/work/a")]: JSON.stringify({ done: true, mode: "other" }) });
    expect(readSetup(wrong, "/work/a")).toBeNull();
    const blocked = store({}, true);
    expect(writeSetup(blocked, "/work/a", { done: true, mode: "skip", at: "" })).toBe(false);
    expect(readSetup(blocked, "/work/a")).toBeNull();
  });

  test("browserStorage reports a blocked store as null", () => {
    const old = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    try {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() {
          throw new Error("blocked");
        },
      });
      expect(browserStorage()).toBeNull();
    } finally {
      if (old) Object.defineProperty(globalThis, "localStorage", old);
    }
  });
});

describe("the provider choices of the flow", () => {
  test("the three implemented vendors with only implemented methods", () => {
    const vendors = setupVendors(all);
    expect(vendors.map((v) => v.id)).toEqual(["anthropic", "openai", "opencode-go"]);
    expect(vendors.flatMap((v) => Object.values(v.methods))).toEqual(["claude-code", "anthropic", "codex", "openai", "opencode-go"]);
    // Another provider stays in Settings.
    expect(setupVendors([...all, status({ id: "ollama", source: "local", implemented: true })])).toHaveLength(3);
    // A method that doi does not implement is not offered.
    expect(setupVendors([status({ id: "codex", implemented: false })])).toEqual([]);
  });

  test("the method starts from the configured provider, with a ready fallback", () => {
    const openaiVendor = vendorOf("codex");
    expect(methodFor(openaiVendor, [codex, openai], "codex")).toBe("oauth");
    // Codex is logged out, but the API key is ready: choose the method that can continue.
    expect(methodFor(openaiVendor, [status({ id: "codex", ready: false, detail: "Not logged in" }), status({ id: "openai", source: "api_key" })], "codex")).toBe("api_key");
    // Nothing is ready: keep the configured method, so its own status and fix show.
    expect(methodFor(openaiVendor, [status({ id: "codex", ready: false, detail: "Not logged in" }), openai], "codex")).toBe("oauth");
    expect(methodFor(openaiVendor, [], "openai")).toBe("api_key");
    expect(methodFor(openaiVendor, [], "nobody")).toBe(defaultMethod(openaiVendor, []));
  });

  test("startChoice uses the configured model only for the configured provider", () => {
    expect(startChoice({ provider: "codex", model: "gpt-6.1-sol" }, all)).toEqual({ vendorId: "openai", method: "oauth", model: "gpt-6.1-sol" });
    expect(startChoice({ provider: "anthropic", model: "claude-opus-5-5" }, all)).toEqual({ vendorId: "anthropic", method: "oauth", model: "" });
    // An unsupported configured provider falls back to the first vendor of the flow.
    expect(startChoice({ provider: "ollama", model: "llama" }, all)).toEqual({ vendorId: "anthropic", method: "oauth", model: "" });
  });

  test("method labels, summaries and ready checks", () => {
    const openaiVendor = vendorOf("codex");
    const anthropicVendor = vendorOf("anthropic");
    expect(methodName(openaiVendor, "oauth")).toBe("ChatGPT subscription");
    expect(methodTag(openaiVendor, "oauth")).toBe("Codex CLI");
    expect(methodSummary(openaiVendor, "api_key")).toBe("API key");
    expect(methodName(anthropicVendor, "oauth")).toBe("Claude subscription");
    expect(methodProvider(openaiVendor, "api_key")).toBe("openai");
    expect(methodProvider(openaiVendor, "local")).toBe("");
    expect(methodReady(all, openaiVendor, "oauth")).toBe(true);
    expect(methodReady([openai], openaiVendor, "oauth")).toBe(false);
    expect(methodReady(all, vendorOf("opencode-go"), "api_key")).toBe(false);
  });

  test("a failed method says what to do, and a ready one has no blocker", () => {
    const openaiVendor = vendorOf("codex");
    expect(methodBlocker(all, openaiVendor, "oauth")).toBeNull();
    expect(methodBlocker([status({ id: "codex", ready: false, detail: "Codex CLI not found on PATH" })], openaiVendor, "oauth")).toContain("not installed");
    expect(methodBlocker([status({ id: "codex", ready: false, detail: "Not logged in" })], openaiVendor, "oauth")).toContain("Not logged in");
    expect(methodBlocker([openai], openaiVendor, "api_key")).toContain("API key");
    expect(methodBlocker([], openaiVendor, "oauth")).toContain("Checking");
    expect(methodBlocker([status({ id: "codex", implemented: false })], openaiVendor, "oauth")).toContain("no adapter");
  });
});

describe("the model choice and save", () => {
  test("the list is the provider catalog; the configured model of another provider is never added", () => {
    expect(modelOptions(["a", "b"], { provider: "codex", model: "b" }, "codex")).toEqual(["a", "b"]);
    expect(modelOptions(["a", "b"], { provider: "claude-code", model: "opus" }, "codex")).toEqual(["a", "b"]);
    expect(modelOptions(["a"], { provider: "codex", model: "gpt-6.1-sol" }, "codex")).toEqual(["gpt-6.1-sol", "a"]);
    expect(modelOptions(["a"], { provider: "codex", model: "--help" }, "codex")).toEqual(["a"]);
  });

  test("a model is kept, else the configured one, else the first of the list", () => {
    expect(pickModel("kept", { provider: "codex", model: "configured" }, "codex", ["first"])).toBe("kept");
    expect(pickModel(null, { provider: "codex", model: "configured" }, "codex", ["first"])).toBe("configured");
    expect(pickModel(null, { provider: "claude-code", model: "configured" }, "codex", ["first"])).toBe("first");
    expect(pickModel(null, { provider: "codex", model: "configured" }, "codex", [])).toBe("configured");
    expect(pickModel(null, { provider: "codex", model: "" }, "codex", [])).toBe("");
    // A configured id that would reach a CLI as a flag is never chosen silently.
    expect(pickModel(null, { provider: "codex", model: "--help" }, "codex", [])).toBe("");
  });

  test("only a ready provider with a valid id can save", () => {
    expect(canSaveModel(all, "codex", "gpt-6.1-sol")).toBe(true);
    expect(canSaveModel([codex], "codex", "gpt-6.1-sol")).toBe(true);
    expect(canSaveModel(all, "codex", "--help")).toBe(false);
    expect(canSaveModel(all, "codex", "")).toBe(false);
    expect(canSaveModel([status({ id: "codex", ready: false })], "codex", "gpt-6.1-sol")).toBe(false);
    expect(canSaveModel(all, "anthropic", "claude-opus-5-5")).toBe(false);
  });

  test("the save body sets generate, edit and extract to one provider:model", () => {
    expect(modelSaveBody("codex", " gpt-6.1-sol ")).toEqual({
      generate: "codex:gpt-6.1-sol",
      edit: "codex:gpt-6.1-sol",
      extract: "codex:gpt-6.1-sol",
    });
    expect(modelSaveBody("opencode-go", "deepseek-v4.1-flash").generate).toBe("opencode-go:deepseek-v4.1-flash");
  });

  test("every setup vendor has a method with a provider id", () => {
    for (const v of setupVendors(all)) expect(Object.values(v.methods).every((id) => typeof id === "string")).toBe(true);
    expect(VENDORS.find((v) => v.id === "openai")?.methods.api_key).toBe("openai");
  });
});
