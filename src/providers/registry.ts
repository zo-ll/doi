import type { Config, ProviderId } from "../config.ts";
import type { Provider } from "./types.ts";
import { createAnthropic } from "./anthropic.ts";
import { createClaudeCode } from "./claude-code.ts";
import { createCodex } from "./codex.ts";
import { createOpenAI } from "./openai.ts";
import { createOpenCodeGo } from "./opencode-go.ts";

const factories: Partial<Record<ProviderId, (config: Config) => Provider>> = {
  anthropic: createAnthropic,
  openai: (config) => createOpenAI(config),
  "opencode-go": (config) => createOpenCodeGo(config),
  "claude-code": (config) => createClaudeCode(config),
  codex: (config) => createCodex(config),
  // M5: google, openrouter, ollama
};

export function isImplemented(id: ProviderId): boolean {
  return id in factories;
}

export function getProvider(id: ProviderId, config: Config): Provider {
  const factory = factories[id];
  if (!factory) throw new Error(`Provider "${id}" is not implemented yet.`);
  return factory(config);
}
