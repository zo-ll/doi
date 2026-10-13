import systemV1 from "./prompts/system-v1.md" with { type: "text" };
import extractV0 from "./prompts/extract-v0.md" with { type: "text" };

/**
 * The system prompt is a versioned file in prompts/. To change it, add system-v2.md and
 * point SYSTEM_PROMPT at it, so a design's chat history can name the version that made it.
 */
export const SYSTEM_PROMPT = { version: "v1", text: systemV1 } as const;

/** The prompt that turns a repo or screenshots into a design system (#43, #44). */
export const EXTRACT_PROMPT = { version: "v0", text: extractV0 } as const;
