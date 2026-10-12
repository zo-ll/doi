import systemV0 from "./prompts/system-v0.md" with { type: "text" };

/**
 * The system prompt is a versioned file in prompts/. To change it, add system-v1.md and
 * point SYSTEM_PROMPT at it, so a design's chat history can name the version that made it.
 */
export const SYSTEM_PROMPT = { version: "v0", text: systemV0 } as const;
