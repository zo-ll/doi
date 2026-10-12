import { readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { ContentPart, Message, Provider, ProviderCapabilities } from "../providers/types.ts";
import { userText, type TurnComment } from "../workspace/chat.ts";

export interface DesignFile {
  /** Path relative to the design folder, with "/" separators. */
  path: string;
  /** File text, or null for a binary asset: the model sees only its name. */
  content: string | null;
}

export interface Turn {
  text: string;
  /** The selected element's data-oid, or null. */
  target?: string | null;
  images?: { mediaType: string; data: Uint8Array }[];
  /** Open comments that this turn applies. */
  comments?: TurnComment[];
}

export interface ContextInput {
  systemPrompt: string;
  /** The active design system as text. Empty until M3. */
  designSystem?: string | null;
  files: DesignFile[];
  /** Earlier messages of this design, oldest first. */
  history: Message[];
  turn: Turn;
  capabilities: ProviderCapabilities;
}

export interface AssembledContext {
  system: string[];
  messages: Message[];
  estimatedTokens: number;
  /** Older history messages that did not fit and were left out. */
  droppedMessages: number;
}

/** Room left for the answer. A full design is about 10k output tokens. */
export const OUTPUT_RESERVE_TOKENS = 16_000;
/** At most this many history messages go to the model, to keep the cost of a turn low. */
export const MAX_HISTORY_MESSAGES = 20;
/** A rough cost of one image. Providers count images differently; this is on the high side. */
export const IMAGE_TOKENS = 1_600;

export class ContextTooLargeError extends Error {
  override name = "ContextTooLargeError";
}

/**
 * About 3 characters per token. HTML and CSS have short tokens, so this errs on the high
 * side. The provider's own count decides; this only keeps a request clearly under the limit.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function messageTokens(m: Message): number {
  return m.content.reduce((n, p) => n + (p.type === "text" ? estimateTokens(p.text) : IMAGE_TOKENS), 4);
}

export function capabilitiesFor(provider: Provider, model: string): ProviderCapabilities {
  return provider.forModel?.(model) ?? provider.capabilities;
}

export function formatFiles(files: DesignFile[]): string {
  const parts = files.map((f) =>
    f.content === null ? `<file path="${f.path}" binary="true" />` : `<file path="${f.path}">\n${f.content}\n</file>`,
  );
  return `# Current design files\n\n${parts.length ? parts.join("\n\n") : "The design is empty."}`;
}

/** The new user message. The target uses the same form as the example in the system prompt. */
export function turnMessage(turn: Turn): Message {
  const content: ContentPart[] = [{ type: "text", text: userText(turn.text, turn.target ?? null, turn.comments) }];
  for (const img of turn.images ?? []) content.push({ type: "image", mediaType: img.mediaType, data: img.data });
  return { role: "user", content };
}

/**
 * Builds the request in the order of the design doc, so the prompt cache can reuse the start:
 * system prompt, design system, current files, then the trimmed history and the new message.
 * The oldest history goes first when the request is too large. A request that is too large
 * without any history is an error.
 */
export function assembleContext(input: ContextInput): AssembledContext {
  const { capabilities, turn } = input;
  if (turn.images?.length && !capabilities.vision) {
    throw new Error("This model does not accept images. Remove the images or choose a model with vision.");
  }

  const system = [input.systemPrompt];
  if (input.designSystem?.trim()) system.push(input.designSystem);
  system.push(formatFiles(input.files));

  const last = turnMessage(turn);
  const budget = capabilities.maxContextTokens - OUTPUT_RESERVE_TOKENS;
  let used = system.reduce((n, s) => n + estimateTokens(s), 0) + messageTokens(last);
  if (used > budget) {
    throw new ContextTooLargeError(
      `The request needs about ${used} tokens, but this model takes ${capabilities.maxContextTokens} ` +
        `(${OUTPUT_RESERVE_TOKENS} of them are kept for the answer). Make the design files smaller ` +
        "or choose a model with a larger context.",
    );
  }

  // Newest first, until the budget or the count limit is reached.
  const kept: Message[] = [];
  for (let i = input.history.length - 1; i >= 0 && kept.length < MAX_HISTORY_MESSAGES; i--) {
    const cost = messageTokens(input.history[i]!);
    if (used + cost > budget) break;
    used += cost;
    kept.unshift(input.history[i]!);
  }
  // The conversation must start with a user message.
  while (kept[0]?.role === "assistant") used -= messageTokens(kept.shift()!);

  return {
    system,
    messages: [...kept, last],
    estimatedTokens: used,
    droppedMessages: input.history.length - kept.length,
  };
}

const TEXT_EXTENSIONS = new Set([".html", ".css", ".json", ".svg", ".md", ".txt", ".js"]);

/** Reads all files of a design folder, sorted, index.html and styles.css first. */
export async function readDesignFiles(dir: string): Promise<DesignFile[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const paths = entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"))
    // Hidden files and folders (.DS_Store, .git) are not part of the design.
    .filter((p) => !p.split("/").some((part) => part.startsWith(".")));
  const rank = (p: string) => (p === "index.html" ? 0 : p === "styles.css" ? 1 : 2);
  paths.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return Promise.all(
    paths.map(async (path) => ({
      path,
      content: TEXT_EXTENSIONS.has(extname(path).toLowerCase()) ? await Bun.file(join(dir, path)).text() : null,
    })),
  );
}
