import { createAnthropic as createAnthropicSDK } from "@ai-sdk/anthropic";
import { createOpenAI as createOpenAISDK } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { keyEnvFor, type Config } from "../config.ts";
import { streamDesign, type CacheMarker } from "./ai-sdk.ts";
import { supportsVision, wireFormat, type WireFormat } from "./opencode-go-formats.ts";
import type { Provider, ProviderCapabilities } from "./types.ts";

export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

const ANTHROPIC_CACHE: CacheMarker = { anthropic: { cacheControl: { type: "ephemeral" } } };

export interface OpenCodeGoDeps {
  /** Replaced in tests; the SDKs call the real fetch by default. */
  fetch?: typeof globalThis.fetch;
}

function model(format: WireFormat, id: string, apiKey: string, baseURL: string, deps: OpenCodeGoDeps): LanguageModel {
  switch (format) {
    case "messages":
      return createAnthropicSDK({ apiKey, baseURL, fetch: deps.fetch })(id);
    case "responses":
      return createOpenAISDK({ apiKey, baseURL, fetch: deps.fetch }).responses(id);
    case "chat":
      return createOpenAICompatible({ name: "opencode-go", apiKey, baseURL, includeUsage: true, fetch: deps.fetch })(id);
  }
}

export function createOpenCodeGo(config: Config, deps: OpenCodeGoDeps = {}): Provider {
  const settings = config.providers["opencode-go"] ?? {};
  const keyEnv = keyEnvFor("opencode-go", config)!;
  const baseURL = settings.base_url ?? OPENCODE_GO_BASE_URL;
  const formatOf = (id: string) => wireFormat(id, settings.formats);

  const capabilities = (id: string): ProviderCapabilities => {
    const format = formatOf(id);
    return {
      vision: supportsVision(id, format),
      toolUse: true,
      // Only the Anthropic format takes explicit cache markers; the others cache on the server side or not at all.
      promptCache: format === "messages" ? "explicit" : "automatic",
      maxContextTokens: 128_000,
      editsFiles: false,
    };
  };

  return {
    id: "opencode-go",
    capabilities: capabilities(""),
    forModel: capabilities,
    async *generate(req) {
      const apiKey = process.env[keyEnv];
      if (!apiKey) throw new Error(`Set ${keyEnv} to use the OpenCode Go provider.`);
      const format = formatOf(req.model);
      yield* streamDesign(
        model(format, req.model, apiKey, baseURL, deps),
        req,
        format === "messages" ? ANTHROPIC_CACHE : undefined,
      );
    },
  };
}
