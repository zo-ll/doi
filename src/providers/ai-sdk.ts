import { streamText, tool, type LanguageModel, type ModelMessage, type SystemModelMessage } from "ai";
import { z } from "zod";
import { SEARCH_REPLACE_PROMPT, SearchReplaceError, SearchReplaceParser, type ParsedEvent } from "./search-replace.ts";
import type { GenerateEvent, GenerateRequest, Message, ProviderCapabilities } from "./types.ts";

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

/** The "file" value of a tool input that is still streaming, once its closing quote has come; else null. */
export function fileOfPartialInput(json: string): string | null {
  const m = /"file"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(json);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return null;
  }
}

export class ProviderError extends Error {
  override name = "ProviderError";
}

/**
 * Runs one generation and maps the AI SDK stream to GenerateEvent. `capabilities` are the
 * provider's capabilities for this model, the same that runTurn() reads. With `toolUse: false`,
 * the model gets no tools: a system part after the system prompt asks for SEARCH/REPLACE
 * blocks (#58), and the parser turns them into edit and write events.
 */
export async function* streamDesign(
  model: LanguageModel,
  req: GenerateRequest,
  capabilities: Pick<ProviderCapabilities, "toolUse">,
  cacheMarker?: CacheMarker,
): AsyncGenerator<GenerateEvent> {
  const blocks = capabilities.toolUse ? null : new SearchReplaceParser();
  const system = blocks ? [...req.system.slice(0, 1), SEARCH_REPLACE_PROMPT.text, ...req.system.slice(1)] : req.system;
  const parsed = (run: () => ParsedEvent[]): ParsedEvent[] => {
    try {
      return run();
    } catch (e) {
      throw e instanceof SearchReplaceError ? new ProviderError(e.message) : e;
    }
  };
  const result = streamText({
    model,
    instructions: toInstructions(system, cacheMarker),
    messages: toModelMessages(req.messages),
    ...(blocks ? {} : { tools: designTools }),
    abortSignal: req.signal,
    // Errors arrive as "error" parts below and are thrown to the caller; skip the SDK's console log.
    onError: () => {},
  });

  // The input of a tool call streams as JSON text: its "file" names the file before the call ends.
  const inputs = new Map<string, string>();
  for await (const part of result.stream) {
    switch (part.type) {
      case "tool-input-start":
        inputs.set(part.id, "");
        break;
      case "tool-input-delta": {
        const sofar = inputs.get(part.id);
        if (sofar === undefined) break;
        const next = sofar + part.delta;
        const file = fileOfPartialInput(next);
        if (file === null) inputs.set(part.id, next);
        else {
          inputs.delete(part.id); // one progress event per call
          yield { type: "progress", file };
        }
        break;
      }
      case "text-delta":
        if (!part.text) break;
        if (blocks) yield* parsed(() => blocks.push(part.text));
        else yield { type: "text", delta: part.text };
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
      case "finish": {
        const usage: GenerateEvent = {
          type: "usage",
          inputTokens: part.totalUsage.inputTokens ?? 0,
          outputTokens: part.totalUsage.outputTokens ?? 0,
          cachedTokens: part.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0,
        };
        // The last tool call is cut and gets no event: the turn must not look complete. Its tokens count.
        if (part.finishReason === "length") {
          yield usage;
          throw new ProviderError("The model reached its output limit before the end of its answer. Ask for fewer pages, or use another model.");
        }
        if (blocks) yield* parsed(() => blocks.end());
        yield usage;
        yield { type: "done" };
        break;
      }
    }
  }
}
