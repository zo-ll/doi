import { createAnthropic as createAnthropicSDK } from "@ai-sdk/anthropic";
import type { Config } from "../config.ts";
import { requireKey } from "./keys.ts";
import { streamDesign } from "./ai-sdk.ts";
import type { Provider } from "./types.ts";

const CACHE_MARKER = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

export function createAnthropic(config: Config): Provider {
  return {
    id: "anthropic",
    capabilities: { vision: true, toolUse: true, promptCache: "explicit", maxContextTokens: 200_000, editsFiles: false },
    async *generate(req) {
      const apiKey = await requireKey("anthropic", config, "the Anthropic API");
      const anthropic = createAnthropicSDK({ apiKey, baseURL: config.providers.anthropic?.base_url });
      yield* streamDesign(anthropic(req.model), req, CACHE_MARKER);
    },
  };
}
