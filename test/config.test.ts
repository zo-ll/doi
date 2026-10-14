import { describe, expect, test } from "bun:test";
import { parseConfig, parseModelRef } from "../src/config.ts";

describe("parseModelRef", () => {
  test("splits provider and model", () => {
    expect(parseModelRef("anthropic:claude-opus-5-5")).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
  });

  test("keeps colons in the model part", () => {
    expect(parseModelRef("ollama:qwen3:32b")).toEqual({ provider: "ollama", model: "qwen3:32b" });
  });

  test("rejects unknown providers and bad shapes", () => {
    expect(() => parseModelRef("mistral:large")).toThrow("Unknown provider");
    expect(() => parseModelRef("anthropic")).toThrow("Invalid model ref");
    expect(() => parseModelRef("anthropic:")).toThrow("Invalid model ref");
  });
});

describe("parseConfig", () => {
  test("fills defaults", () => {
    const config = parseConfig({}, "/tmp/doi");
    expect(config.workspace).toBe("/tmp/doi/workspace");
    expect(config.models.edit.provider).toBe("claude-code");
  });

  test("reads TOML values", () => {
    const raw = Bun.TOML.parse(`
      workspace = "/data/doi"
      [models]
      edit = "openai:gpt-small"
    `) as Record<string, any>;
    const config = parseConfig(raw);
    expect(config.workspace).toBe("/data/doi");
    expect(config.models.edit).toEqual({ provider: "openai", model: "gpt-small" });
  });
});

describe("config.toml from the UI", () => {
  const models = {
    generate: { provider: "claude-code" as const, model: "claude-opus-5-5" },
    edit: { provider: "codex" as const, model: "default" },
    extract: { provider: "claude-code" as const, model: "claude-haiku-5-5" },
  };

  test("changes only the model lines; comments and other tables stay", async () => {
    const { withModels } = await import("../src/config.ts");
    const text = [
      "# my config",
      'workspace = "/data/doi"',
      "",
      "[models]",
      'generate = "anthropic:big"   # the best one',
      "# edit = \"openai:x\"",
      'extract = "anthropic:small"',
      "",
      "[providers.openai]",
      'api_key_env = "MY_KEY"',
    ].join("\n");
    const out = withModels(text, models);
    expect(out).toContain('# my config\nworkspace = "/data/doi"');
    expect(out).toContain('[models]\nedit = "codex:default"\ngenerate = "claude-code:claude-opus-5-5"\n# edit = "openai:x"\nextract = "claude-code:claude-haiku-5-5"');
    expect(out).toContain('[providers.openai]\napi_key_env = "MY_KEY"');
    const parsed = parseConfig(Bun.TOML.parse(out) as Record<string, any>);
    expect(parsed.models).toEqual(models);
    expect(parsed.workspace).toBe("/data/doi");
  });

  test("adds the table when the file has none, or when there is no file", async () => {
    const { withModels } = await import("../src/config.ts");
    expect(withModels("", models)).toBe('[models]\ngenerate = "claude-code:claude-opus-5-5"\nedit = "codex:default"\nextract = "claude-code:claude-haiku-5-5"\n');
    expect(withModels("port = 5000\n", models)).toStartWith("port = 5000\n\n[models]\n");
  });

  test("prices per model; bad entries are left out", () => {
    const c = parseConfig({ prices: { "anthropic:m": { input: 3, output: 15, cached: 0.3 }, "openai:x": { input: 2, output: "a lot" }, "x:y": 4 } });
    expect(c.prices).toEqual({ "anthropic:m": { input: 3, output: 15, cached: 0.3 } });
    expect(parseConfig({}).prices).toEqual({});
  });
});
