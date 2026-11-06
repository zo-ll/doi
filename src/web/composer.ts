import { useState } from "react";
import { IMAGE_LIMITS } from "../workspace/image-limits.ts";
import { isImageType, prepareImage, type PreparedImage } from "./images.ts";

/** The images of a message: from the picker, a paste or a drop. Large images are scaled down here. */
export function useComposerImages() {
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const addImages = async (files: File[]) => {
    const picked = files.filter((f) => f.type.startsWith("image/"));
    if (!picked.length) return;
    setImageError(null);
    const room = IMAGE_LIMITS.count - images.length;
    if (picked.length > room) setImageError(`At most ${IMAGE_LIMITS.count} images in one message.`);
    const added: PreparedImage[] = [];
    for (const f of picked.slice(0, Math.max(0, room))) {
      try {
        if (!isImageType(f.type)) throw new Error(`Use a PNG, JPEG, WebP or GIF image (not ${f.type}).`);
        added.push(await prepareImage(f));
      } catch (e) {
        setImageError(e instanceof Error ? e.message : String(e));
      }
    }
    setImages((list) => [...list, ...added].slice(0, IMAGE_LIMITS.count));
  };
  return { images, setImages, imageError, setImageError, addImages };
}

/** One entry per provider and model. */
export function modelChoices<T extends { provider: string; model: string }>(tasks: readonly T[]): T[] {
  return tasks.filter((t, i) => tasks.findIndex((x) => x.provider === t.provider && x.model === t.model) === i);
}
