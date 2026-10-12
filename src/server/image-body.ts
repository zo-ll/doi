import { IMAGE_LIMITS, IMAGE_TYPES, isImageType, type ImageType } from "../workspace/uploads.ts";

/**
 * Images from a JSON body: `[{ mediaType, data }]` with base64 data, already scaled by the
 * browser to IMAGE_LIMITS. Returns the bytes, or a message that says what is wrong.
 */
export function parseImages(raw: unknown): { mediaType: ImageType; data: Uint8Array }[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "images must be a list.";
  if (raw.length > IMAGE_LIMITS.count) return `Send at most ${IMAGE_LIMITS.count} images in one message.`;
  const out: { mediaType: ImageType; data: Uint8Array }[] = [];
  for (const img of raw) {
    const { mediaType, data } = (img ?? {}) as Record<string, unknown>;
    if (typeof mediaType !== "string" || !isImageType(mediaType)) {
      return `Images must be ${Object.keys(IMAGE_TYPES).join(", ")}.`;
    }
    if (typeof data !== "string" || !data) return "Each image needs base64 data.";
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length) return "An image is empty.";
    if (bytes.length > IMAGE_LIMITS.bytes) {
      return `An image is larger than ${Math.round(IMAGE_LIMITS.bytes / 1_000_000)} MB. The app scales images down; send the scaled image.`;
    }
    out.push({ mediaType, data: new Uint8Array(bytes) });
  }
  return out;
}
