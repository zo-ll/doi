/**
 * OpenCode Go serves each model through one of three wire formats.
 * Source: https://opencode.ai/v2/docs/console/go (checked 2026-10-12).
 * The model list changes often: unknown models fall back to prefix rules,
 * and `[providers.opencode-go.formats]` in config.toml overrides both.
 */
export type WireFormat = "chat" | "messages" | "responses";

export const WIRE_FORMATS: readonly WireFormat[] = ["chat", "messages", "responses"];

const KNOWN: Record<string, WireFormat> = {
  "grok-4.7": "responses",
  "grok-4.6": "responses",
  "gpt-6-luna": "responses",
  "gpt-5.6-luna": "responses",
  "muse-spark-1.3-contributor": "responses",
  "muse-spark-1.2-contributor": "responses",
  "claude-haiku-5-5": "messages",
  "minimax-m3": "messages",
  "minimax-m2.7": "messages",
  "qwen3.8-max": "messages",
  "qwen3.8-flash": "messages",
  "qwen3.7-plus": "messages",
};

const PREFIXES: [string, WireFormat][] = [
  ["gpt-", "responses"],
  ["grok-", "responses"],
  ["muse-", "responses"],
  ["claude-", "messages"],
  ["minimax-", "messages"],
  ["qwen", "messages"],
];

export function wireFormat(model: string, overrides: Record<string, string> = {}): WireFormat {
  const override = overrides[model];
  if (override !== undefined) {
    if (!WIRE_FORMATS.includes(override as WireFormat)) {
      throw new Error(`Unknown OpenCode Go format "${override}" for ${model}. Use chat, messages or responses.`);
    }
    return override as WireFormat;
  }
  return KNOWN[model] ?? PREFIXES.find(([prefix]) => model.startsWith(prefix))?.[1] ?? "chat";
}

/**
 * Image input: the messages and responses models accept images. Of the chat models,
 * only the ones marked "vision" in their id do.
 */
export function supportsVision(model: string, format: WireFormat): boolean {
  return format !== "chat" || model.includes("vision");
}
