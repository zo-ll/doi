// No Node imports here: the web bundle uses these limits too.

/** Image types that all vision providers accept, with the file extension for each. */
export const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as const;
export type ImageType = keyof typeof IMAGE_TYPES;

/**
 * One limit for all providers. The browser scales larger images down to it. Anthropic allows
 * 5 MB of base64 (about 3.75 MB of bytes) and recommends at most 1568 px on the long edge;
 * OpenAI and Gemini scale large images down themselves.
 */
export const IMAGE_LIMITS = { edge: 1568, bytes: 3_750_000, count: 5 } as const;
