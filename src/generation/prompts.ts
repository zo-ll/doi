import systemV3 from "./prompts/system-v3.md" with { type: "text" };
import extractV0 from "./prompts/extract-v0.md" with { type: "text" };

/**
 * The system prompt is a versioned file in prompts/. To change it, add a new file and
 * point SYSTEM_PROMPT at it, so a design's chat history can name the version that made it.
 */
export const SYSTEM_PROMPT = { version: "v3", text: systemV3 } as const;

/** The prompt that turns a repo or screenshots into a design system (#43, #44). */
export const EXTRACT_PROMPT = { version: "v0", text: extractV0 } as const;
