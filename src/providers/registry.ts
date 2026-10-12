import type { Config, ProviderId } from "../config.ts";
import type { Provider } from "./types.ts";
import { createAnthropic } from "./anthropic.ts";
import { createClaudeCode } from "./claude-code.ts";
import { createOpenAI } from "./openai.ts";
import { createOpenCodeGo } from "./opencode-go.ts";

const factories: Partial<Record<ProviderId, (config: Config) => Provider>> = {
  anthropic: createAnthropic,
  openai: createOpenAI,
  "opencode-go": (config) => createOpenCodeGo(config),
  "claude-code": (config) => createClaudeCode(config),
  // #73 codex; M5: google, openrouter, ollama
};

export function isImplemented(id: ProviderId): boolean {
  return id in factories;
}

export function getProvider(id: ProviderId, config: Config): Provider {
  const factory = factories[id];
  if (!factory) throw new Error(`Provider "${id}" is not implemented yet.`);
  return factory(config);
}
