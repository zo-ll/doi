import { createAnthropic as createAnthropicSDK } from "@ai-sdk/anthropic";
import type { Config } from "../config.ts";
import { streamDesign } from "./ai-sdk.ts";
import type { Provider } from "./types.ts";

const CACHE_MARKER = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

export function createAnthropic(config: Config): Provider {
  const keyEnv = config.providers.anthropic?.api_key_env ?? "ANTHROPIC_API_KEY";
  return {
    id: "anthropic",
    capabilities: { vision: true, toolUse: true, promptCache: "explicit", maxContextTokens: 200_000 },
    async *generate(req) {
      const apiKey = process.env[keyEnv];
      if (!apiKey) throw new Error(`Set ${keyEnv} to use the Anthropic provider.`);
      const anthropic = createAnthropicSDK({ apiKey, baseURL: config.providers.anthropic?.base_url });
      yield* streamDesign(anthropic(req.model), req, CACHE_MARKER);
    },
  };
}
