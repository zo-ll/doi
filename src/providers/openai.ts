import { keyEnvFor, type Config } from "../config.ts";
import type { Provider } from "./types.ts";

export function createOpenAI(config: Config): Provider {
  const keyEnv = keyEnvFor("openai", config)!;
  return {
    id: "openai",
    capabilities: { vision: true, toolUse: true, promptCache: "automatic", maxContextTokens: 128_000, editsFiles: false },
    async *generate(_req) {
      if (!process.env[keyEnv]) throw new Error(`Set ${keyEnv} to use the OpenAI provider.`);
      // M1: streamText from "ai" + @ai-sdk/openai, with edit/write tools. Map the stream to GenerateEvent.
      throw new Error("openai.generate is not implemented yet (M1).");
    },
  };
}
