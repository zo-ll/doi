import type { Config, ProviderId } from "../config.ts";
import type { Provider } from "./types.ts";
import { createAnthropic } from "./anthropic.ts";
import { createOpenAI } from "./openai.ts";

const factories: Partial<Record<ProviderId, (config: Config) => Provider>> = {
  anthropic: createAnthropic,
  openai: createOpenAI,
  // M5: google, openrouter, ollama
};

export function getProvider(id: ProviderId, config: Config): Provider {
  const factory = factories[id];
  if (!factory) throw new Error(`Provider "${id}" is not implemented yet.`);
  return factory(config);
}
