import { expect, test } from "bun:test";
import type { ProviderStatus } from "../src/providers/status.ts";
import { defaultMethod, methodsOf, shortModel, statusOf, taskStatuses, vendorOf, VENDORS } from "../src/web/providers.ts";

const p = (over: Partial<ProviderStatus>): ProviderStatus => ({ id: "claude-code", source: "cli", ready: true, detail: "Logged in", implemented: true, ...over });

test("status tones and labels", () => {
  expect(statusOf(p({}))).toMatchObject({ tone: "ok", label: "Logged in" });
  expect(statusOf(p({ ready: false, detail: "Codex CLI not found on PATH" }))).toMatchObject({ tone: "err", label: "CLI not found" });
  expect(statusOf(p({ ready: false, detail: "Not logged in. Run: claude auth login" }))).toMatchObject({ tone: "warn", label: "Not logged in" });
  expect(statusOf(p({ source: "api_key", ready: false, detail: "Set OPENAI_API_KEY" }))).toMatchObject({ tone: "warn", label: "Missing API key" });
  expect(statusOf(p({ source: "api_key", detail: "Key from ANTHROPIC_API_KEY" }))).toMatchObject({ tone: "ok", label: "Ready" });
  expect(statusOf(p({ source: "local", ready: false, detail: "No Ollama server at 127.0.0.1:11434" }))).toMatchObject({ tone: "err", label: "Not running" });
  expect(statusOf(p({ implemented: false }))).toMatchObject({ tone: "err", label: "Not available" });
  expect(statusOf(undefined).tone).toBe("unknown");
});

test("one status per task, in task order", () => {
  const models = {
    generate: { provider: "claude-code", model: "claude-opus-5-5" },
    edit: { provider: "claude-code", model: "claude-sonnet-5-5" },
    extract: { provider: "openai", model: "gpt-6" },
  };
  const list = taskStatuses(models, [p({}), p({ id: "openai", source: "api_key", ready: false, detail: "Set OPENAI_API_KEY" })]);
  expect(list.map((t) => [t.task, t.model, t.tone])).toEqual([
    ["generate", "claude-opus-5-5", "ok"],
    ["edit", "claude-sonnet-5-5", "ok"],
    ["extract", "gpt-6", "warn"],
  ]);
  expect(taskStatuses(models, null)[0]).toMatchObject({ tone: "unknown", label: "Checking…" });
});

test("short model names", () => {
  expect(shortModel("claude-opus-5-5")).toBe("Opus 5.5");
  expect(shortModel("claude-haiku-5-5")).toBe("Haiku 5.5");
  expect(shortModel("gpt-6-luna")).toBe("gpt-6-luna");
  expect(shortModel("claude-opus")).toBe("claude-opus");
});

test("every provider belongs to one vendor, with its methods in order", () => {
  const ids = VENDORS.flatMap((v) => Object.values(v.methods));
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.toSorted()).toEqual(["anthropic", "claude-code", "codex", "google", "ollama", "openai", "opencode-go", "openrouter"]);
  expect(methodsOf(vendorOf("codex"))).toEqual(["oauth", "api_key"]);
  expect(methodsOf(vendorOf("opencode-go"))).toEqual(["api_key"]);
  expect(vendorOf("nobody").id).toBe("anthropic");
});

test("the first method shown is one that is ready", () => {
  const anthropic = vendorOf("anthropic");
  expect(defaultMethod(anthropic, [])).toBe("oauth");
  expect(defaultMethod(anthropic, [p({ ready: false }), p({ id: "anthropic", source: "api_key", ready: true })])).toBe("api_key");
  expect(defaultMethod(anthropic, [p({}), p({ id: "anthropic", source: "api_key", ready: true })])).toBe("oauth");
});
