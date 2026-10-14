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
