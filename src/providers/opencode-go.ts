import { createAnthropic as createAnthropicSDK } from "@ai-sdk/anthropic";
import { createOpenAI as createOpenAISDK } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { Config } from "../config.ts";
import { requireKey } from "./keys.ts";
import { streamDesign, type CacheMarker } from "./ai-sdk.ts";
import { supportsVision, wireFormat, type WireFormat } from "./opencode-go-formats.ts";
import type { Provider, ProviderCapabilities } from "./types.ts";

// Source: https://opencode.ai/docs/go/ (checked 2026-10-15). The old /zen/go/v1 prefix still answers.
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/inference/go/v1";

/**
 * OpenCode Go asks each client to name itself in the user agent and to send a stable
 * `x-opencode-session` per conversation, for routing and the prompt cache.
 */
export const DOI_USER_AGENT = "doi/0.1";

const ANTHROPIC_CACHE: CacheMarker = { anthropic: { cacheControl: { type: "ephemeral" } } };

export interface OpenCodeGoDeps {
  /** Replaced in tests; the SDKs call the real fetch by default. */
  fetch?: typeof globalThis.fetch;
}

function model(format: WireFormat, id: string, apiKey: string, baseURL: string, session: string, deps: OpenCodeGoDeps): LanguageModel {
  const headers = { "user-agent": DOI_USER_AGENT, "x-opencode-session": session };
  switch (format) {
    case "messages":
      return createAnthropicSDK({ apiKey, baseURL, headers, fetch: deps.fetch })(id);
    case "responses":
      return createOpenAISDK({ apiKey, baseURL, headers, fetch: deps.fetch }).responses(id);
    case "chat":
      return createOpenAICompatible({ name: "opencode-go", apiKey, baseURL, headers, includeUsage: true, fetch: deps.fetch })(id);
  }
}

export function createOpenCodeGo(config: Config, deps: OpenCodeGoDeps = {}): Provider {
  const settings = config.providers["opencode-go"] ?? {};
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
      const apiKey = await requireKey("opencode-go", config, "OpenCode Go");
      const format = formatOf(req.model);
      yield* streamDesign(
        // A request without a conversation (a manual check) gets its own id.
        model(format, req.model, apiKey, baseURL, req.session ?? crypto.randomUUID(), deps),
        req,
        format === "messages" ? ANTHROPIC_CACHE : undefined,
        { toolUse: capabilities(req.model).toolUse },
      );
    },
  };
}
