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

  test("rejects invalid config values before they reach typed consumers", () => {
    const invalid: unknown[] = [
      null, [], "config", { workspace: 7 }, { port: true }, { port: "not a port" },
      { port: -1 }, { port: 65536 }, { port: 1.5 }, { models: [] },
      { models: { generate: 7 } }, { providers: [] },
      { providers: { openai: "not a table" } },
      { providers: { openai: { api_key_env: false } } },
      { providers: { openai: { base_url: 7 } } },
      { providers: { "opencode-go": { formats: { model: 7 } } } },
      { editor_url: false },
    ];
    for (const raw of invalid) expect(() => parseConfig(raw)).toThrow();
  });

  test("keeps numeric ports, null defaults and independent provider values", () => {
    expect(parseConfig({ port: "5000" }).port).toBe(5000);
    expect(parseConfig({ port: 0 }).port).toBe(0);
    expect(parseConfig({ workspace: null, port: null, models: null, providers: null }).port).toBe(4317);
    const raw = { providers: { openai: { base_url: "https://proxy.example/v1" } } };
    const config = parseConfig(raw);
    raw.providers.openai.base_url = "https://changed.example/v1";
    expect(config.providers.openai?.base_url).toBe("https://proxy.example/v1");
  });

  test("reads TOML values", () => {
    const raw = Bun.TOML.parse(`
      workspace = "/data/doi"
      [models]
      edit = "openai:gpt-small"
    `);
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
    expect(out).toContain('[models]\nedit = "codex:default"\ngenerate = "claude-code:claude-opus-5-5"   # the best one\n# edit = "openai:x"\nextract = "claude-code:claude-haiku-5-5"');
    expect(out).toContain('[providers.openai]\napi_key_env = "MY_KEY"');
    const parsed = parseConfig(Bun.TOML.parse(out));
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

test("the [prices] table is replaced whole; other tables stay", async () => {
  const { withPrices } = await import("../src/config.ts");
  const text = 'port = 1\n\n[prices]\n"a:b" = { input = 1, output = 2 }\n\n[prices."c:d"]\ninput = 9\noutput = 9\n\n[models]\ngenerate = "codex:x"\n';
  const out = withPrices(text, { "anthropic:m": { input: 3, output: 15, cached: 0.3 } });
  expect(out).toContain('[models]\ngenerate = "codex:x"');
  expect(out).not.toContain("a:b");
  expect(out).not.toContain("c:d");
  const parsed = parseConfig(Bun.TOML.parse(out));
  expect(parsed.prices).toEqual({ "anthropic:m": { input: 3, output: 15, cached: 0.3 } });
  expect(withPrices(text, {})).not.toContain("[prices");
});
