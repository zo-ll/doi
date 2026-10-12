import { IMAGE_LIMITS, isImageType, type ImageType } from "../workspace/image-limits.ts";

export { isImageType };

export interface PreparedImage {
  mediaType: ImageType;
  /** Base64 without the data: prefix, as the turn request expects it. */
  data: string;
  /** A data: URL for the thumbnail. */
  url: string;
}

/** The size that fits `edge` on the long side and keeps the aspect ratio. Never scales up. */
export function fitWithin(width: number, height: number, edge: number): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/**
 * Reads an image and scales it down when it is larger than IMAGE_LIMITS (long edge or bytes).
 * A scaled image becomes JPEG, or PNG when the original was a PNG and the PNG fits.
 */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  if (!isImageType(file.type)) throw new Error(`Use a PNG, JPEG, WebP or GIF image (not ${file.type || "this file"}).`);
  const bitmap = await createImageBitmap(file);
  const fits = Math.max(bitmap.width, bitmap.height) <= IMAGE_LIMITS.edge && file.size <= IMAGE_LIMITS.bytes;
  let blob: Blob = file;
  let mediaType: ImageType = file.type;
  if (!fits) {
    const size = fitWithin(bitmap.width, bitmap.height, IMAGE_LIMITS.edge);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, size.width, size.height);
    const encode = (type: string, quality?: number) =>
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be scaled."))), type, quality),
      );
    blob = file.type === "image/png" ? await encode("image/png") : await encode("image/jpeg", 0.85);
    // Screenshots with photos can stay large as PNG; JPEG at lower quality then fits.
    for (let q = 0.85; blob.size > IMAGE_LIMITS.bytes && q > 0.3; q -= 0.15) blob = await encode("image/jpeg", q);
    if (blob.size > IMAGE_LIMITS.bytes) throw new Error("The image is too large, even after scaling.");
    mediaType = blob.type as ImageType;
  }
  bitmap.close();
  const url = await toDataUrl(blob);
  return { mediaType, data: url.slice(url.indexOf(",") + 1), url };
}
