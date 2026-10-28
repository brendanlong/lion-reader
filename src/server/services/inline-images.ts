/**
 * Storing the images the absolutize pass moves out of an entry's HTML
 * (`rewriteContentUrls`), under the entry's objects prefix
 * (`stored-objects.ts`).
 */

import type { ExtractedImage } from "@lion-reader/sanitizer";
import { logger } from "@/lib/logger";
import { errors } from "@/server/errors";
import { getPublicObjectUrl, isStorageAvailable, uploadObject } from "@/server/storage/s3";

/**
 * The URL prefix the absolutize pass rewrites an entry's inlined images to
 * (`rewriteContentUrls`), or null when storage isn't configured, which leaves
 * them inline.
 */
export function inlineImageUrlPrefix(objectsPrefix: string): string | null {
  return isStorageAvailable() ? getPublicObjectUrl(objectsPrefix) : null;
}

/** How many of an entry's images {@link storeExtractedImages} uploads at once. */
const IMAGE_UPLOAD_CONCURRENCY = 8;

/**
 * Stores the images the absolutize pass moved out of an entry's HTML under its
 * `objectsPrefix`.
 *
 * @throws STORAGE_FAILED if storage refuses one: the HTML points at them, so
 *   the save must fail
 */
export async function storeExtractedImages(
  objectsPrefix: string,
  images: ExtractedImage[]
): Promise<void> {
  const queue = [...images];
  const upload = async (): Promise<void> => {
    for (let image = queue.pop(); image; image = queue.pop()) {
      await uploadObject(`${objectsPrefix}${image.name}`, image.data, image.contentType);
    }
  };
  try {
    await Promise.all(Array.from({ length: IMAGE_UPLOAD_CONCURRENCY }, upload));
  } catch (error) {
    logger.error("Couldn't store an entry's inlined images", {
      objectsPrefix,
      error: error instanceof Error ? error.message : String(error),
    });
    throw errors.storageFailed("Try again.");
  }
}
