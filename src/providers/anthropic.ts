import type { Config } from "../config.ts";
import type { Provider } from "./types.ts";

export function createAnthropic(config: Config): Provider {
  const keyEnv = config.providers.anthropic?.api_key_env ?? "ANTHROPIC_API_KEY";
  return {
    id: "anthropic",
    capabilities: { vision: true, toolUse: true, promptCache: "explicit", maxContextTokens: 200_000 },
    async *generate(_req) {
      if (!process.env[keyEnv]) throw new Error(`Set ${keyEnv} to use the Anthropic provider.`);
      // M1: streamText from "ai" + @ai-sdk/anthropic, with edit/write tools and cache markers
      // on the last system part. Map the stream to GenerateEvent.
      throw new Error("anthropic.generate is not implemented yet (M1).");
    },
  };
}
