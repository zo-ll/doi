import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertName } from "./paths.ts";
import { IMAGE_TYPES, type ImageType } from "./image-limits.ts";

export { IMAGE_LIMITS, IMAGE_TYPES, isImageType, type ImageType } from "./image-limits.ts";

const UPLOAD_NAME = /^[0-9a-f-]{36}-\d\.(png|jpg|webp|gif)$/;

export function uploadsDir(workspace: string, project: string): string {
  assertName("project", project);
  return join(workspace, "projects", project, "uploads");
}

/** Path of one upload, or null for a name that is not an upload (no path traversal). */
export function uploadFile(workspace: string, project: string, name: string): string | null {
  return UPLOAD_NAME.test(name) ? join(uploadsDir(workspace, project), name) : null;
}

/** Saves the images of one turn as uploads/<turn>-<n>.<ext>. Returns the file names. */
export async function saveUploads(
  workspace: string,
  project: string,
  turn: string,
  images: { mediaType: ImageType; data: Uint8Array }[],
): Promise<string[]> {
  if (!images.length) return [];
  const dir = uploadsDir(workspace, project);
  await mkdir(dir, { recursive: true });
  const names: string[] = [];
  for (const [i, img] of images.entries()) {
    const name = `${turn}-${i}.${IMAGE_TYPES[img.mediaType]}`;
    await Bun.write(join(dir, name), img.data);
    names.push(name);
  }
  return names;
}
