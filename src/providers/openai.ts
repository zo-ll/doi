import { createOpenAI as createOpenAISDK } from "@ai-sdk/openai";
import type { Config } from "../config.ts";
import { requireKey } from "./keys.ts";
import { streamDesign } from "./ai-sdk.ts";
import type { Provider, ProviderCapabilities } from "./types.ts";

export interface OpenAIDeps {
  /** Replaced in tests; the SDK calls the real fetch by default. */
  fetch?: typeof globalThis.fetch;
}

export function createOpenAI(config: Config, deps: OpenAIDeps = {}): Provider {
  const capabilities: ProviderCapabilities = { vision: true, toolUse: true, promptCache: "automatic", maxContextTokens: 128_000, editsFiles: false };
  return {
    id: "openai",
    capabilities,
    async *generate(req) {
      const apiKey = await requireKey("openai", config, "the OpenAI API");
      const openai = createOpenAISDK({ apiKey, baseURL: config.providers.openai?.base_url, fetch: deps.fetch });
      // The Responses API caches a stable prefix without markers, so no cache marker goes to streamDesign.
      yield* streamDesign(openai.responses(req.model), req, capabilities);
    },
  };
}
