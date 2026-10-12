import type { ProviderId } from "../config.ts";

export interface ProviderCapabilities {
  vision: boolean;
  /** false = the adapter asks for SEARCH/REPLACE text blocks and parses them into edit events. */
  toolUse: boolean;
  promptCache: "explicit" | "automatic" | "none";
  maxContextTokens: number;
  /** true for CLI backends that edit the design files themselves; the edit applier skips them. */
  editsFiles: boolean;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: Uint8Array };

export interface Message {
  role: "user" | "assistant";
  content: ContentPart[];
}

export interface GenerateRequest {
  model: string;
  /** Stable parts first (rules, design system, current files) so the prompt cache can reuse them. */
  system: string[];
  messages: Message[];
  signal?: AbortSignal;
  /** The design folder. Required by providers with `editsFiles`, which work in it directly. */
  cwd?: string;
}

export type GenerateEvent =
  | { type: "text"; delta: string }
  | { type: "edit"; file: string; oldText: string; newText: string }
  | { type: "write"; file: string; content: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedTokens: number }
  | { type: "done" };

export interface Provider {
  id: ProviderId;
  capabilities: ProviderCapabilities;
  /** Capabilities of one model, for providers whose models differ (OpenCode Go). */
  forModel?(model: string): ProviderCapabilities;
  generate(req: GenerateRequest): AsyncIterable<GenerateEvent>;
}
