import { streamText, tool, type LanguageModel, type ModelMessage, type SystemModelMessage } from "ai";
import { z } from "zod";
import type { GenerateEvent, GenerateRequest, Message } from "./types.ts";

/**
 * The model proposes file changes through these tools. They have no `execute`:
 * the edit applier (#6) applies the changes, so all file writes stay in one place.
 */
export const designTools = {
  edit: tool({
    description:
      "Replace one exact, unique occurrence of oldText with newText in a design file. " +
      "Use this for every change to an existing file. Include enough context to make oldText unique.",
    inputSchema: z.object({
      file: z.string().describe("Path relative to the design folder, for example styles.css"),
      oldText: z.string().min(1).describe("Exact text to replace; must occur once in the file"),
      newText: z.string().describe("Replacement text"),
    }),
  }),
  write: tool({
    description: "Create a new design file, or replace a whole file when an edit is not practical.",
    inputSchema: z.object({
      file: z.string().describe("Path relative to the design folder, for example index.html"),
      content: z.string().describe("The full file content"),
    }),
  }),
};

export type CacheMarker = SystemModelMessage["providerOptions"];

/** Anthropic takes at most 4 cache breakpoints in one request. */
const MAX_CACHE_MARKERS = 4;

/**
 * System parts become separate system messages. Each part gets the cache marker, so a turn
 * that changes only the design files still reads the system prompt and the design system
 * from the cache. With more parts than breakpoints, the last parts get the markers.
 */
export function toInstructions(system: string[], cacheMarker?: CacheMarker): SystemModelMessage[] {
  return system.map((content, i) => ({
    role: "system",
    content,
    ...(cacheMarker && i >= system.length - MAX_CACHE_MARKERS ? { providerOptions: cacheMarker } : {}),
  }));
}

export function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === "assistant") {
      const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
      return { role: "assistant", content: text };
    }
    return {
      role: "user",
      content: m.content.map((p) =>
        p.type === "text" ? { type: "text", text: p.text } : { type: "file", mediaType: p.mediaType, data: p.data },
      ),
    };
  });
}

export class ProviderError extends Error {
  override name = "ProviderError";
}

/** Runs one generation and maps the AI SDK stream to GenerateEvent. */
export async function* streamDesign(
  model: LanguageModel,
  req: GenerateRequest,
  cacheMarker?: CacheMarker,
): AsyncGenerator<GenerateEvent> {
  const result = streamText({
    model,
    instructions: toInstructions(req.system, cacheMarker),
    messages: toModelMessages(req.messages),
    tools: designTools,
    abortSignal: req.signal,
    // Errors arrive as "error" parts below and are thrown to the caller; skip the SDK's console log.
    onError: () => {},
  });

  for await (const part of result.stream) {
    switch (part.type) {
      case "text-delta":
        if (part.text) yield { type: "text", delta: part.text };
        break;
      case "tool-call": {
        if (part.invalid || part.dynamic) {
          throw new ProviderError(`The model sent an invalid "${part.toolName}" call.`);
        }
        if (part.toolName === "edit") {
          yield { type: "edit", file: part.input.file, oldText: part.input.oldText, newText: part.input.newText };
        } else if (part.toolName === "write") {
          yield { type: "write", file: part.input.file, content: part.input.content };
        }
        break;
      }
      case "tool-error":
        throw new ProviderError(`The "${part.toolName}" call failed: ${String(part.error)}`);
      case "error":
        throw part.error instanceof Error ? part.error : new ProviderError(String(part.error));
      case "abort":
        throw new DOMException("The generation was stopped.", "AbortError");
      case "finish":
        yield {
          type: "usage",
          inputTokens: part.totalUsage.inputTokens ?? 0,
          outputTokens: part.totalUsage.outputTokens ?? 0,
          cachedTokens: part.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0,
        };
        yield { type: "done" };
        break;
    }
  }
}
