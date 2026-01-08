/**
 * S3-compatible Object Storage
 *
 * Provides functions for uploading and managing files in S3-compatible storage.
 * Works with AWS S3, Fly.io Tigris, and other S3-compatible services.
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { logger } from "@/lib/logger";
import { storageConfig } from "@/server/config/env";
import { randomUUID } from "crypto";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Checks if object storage is configured and available.
 */
export function isStorageAvailable(): boolean {
  return !!(
    storageConfig.bucket &&
    storageConfig.accessKeyId &&
    storageConfig.secretAccessKey
  );
}

/**
 * Lazily initialized S3 client.
 */
let s3Client: S3Client | null = null;

/**
 * Gets or creates the S3 client.
 */
function getS3Client(): S3Client | null {
  if (!isStorageAvailable()) {
    return null;
  }

  if (s3Client) {
    return s3Client;
  }

  s3Client = new S3Client({
    endpoint: storageConfig.endpoint,
    region: storageConfig.region,
    credentials: {
      accessKeyId: storageConfig.accessKeyId!,
      secretAccessKey: storageConfig.secretAccessKey!,
    },
    // Tigris requires path-style addressing
    forcePathStyle: !!storageConfig.endpoint,
  });

  return s3Client;
}

// ============================================================================
// Public URL Generation
// ============================================================================

/**
 * Gets the public URL for an object in storage.
 *
 * @param key - The object key (path within bucket)
 * @returns The public URL for the object
 */
export function getPublicUrl(key: string): string {
  if (storageConfig.publicUrlBase) {
    // Use configured public URL base
    const base = storageConfig.publicUrlBase.replace(/\/$/, "");
    return `${base}/${key}`;
  }

  if (storageConfig.endpoint?.includes("tigris")) {
    // Tigris URL pattern
    return `https://${storageConfig.bucket}.fly.storage.tigris.dev/${key}`;
  }

  // AWS S3 URL pattern
  return `https://${storageConfig.bucket}.s3.${storageConfig.region}.amazonaws.com/${key}`;
}

// ============================================================================
// Image Upload
// ============================================================================

/**
 * Result of uploading an image.
 */
export interface UploadResult {
  /** The storage key (path) of the uploaded object */
  key: string;
  /** The public URL to access the image */
  url: string;
  /** Content type of the uploaded file */
  contentType: string;
  /** Size in bytes */
  size: number;
}

/**
 * Determines content type from image data or URL.
 */
function detectContentType(
  data: Buffer,
  sourceUrl?: string
): string {
  // Check magic bytes
  if (data[0] === 0xff && data[1] === 0xd8) {
    return "image/jpeg";
  }
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return "image/png";
  }
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return "image/gif";
  }
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
    // Could be WebP (RIFF....WEBP)
    if (data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
      return "image/webp";
    }
  }

  // Fallback to URL extension
  if (sourceUrl) {
    const url = new URL(sourceUrl);
    const ext = url.pathname.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "jpg":
      case "jpeg":
        return "image/jpeg";
      case "png":
        return "image/png";
      case "gif":
        return "image/gif";
      case "webp":
        return "image/webp";
      case "svg":
        return "image/svg+xml";
    }
  }

  // Default to jpeg
  return "image/jpeg";
}

/**
 * Gets file extension from content type.
 */
function getExtension(contentType: string): string {
  switch (contentType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "bin";
  }
}

/**
 * Uploads an image to object storage.
 *
 * @param data - The image data as a Buffer
 * @param options - Upload options
 * @returns Upload result with URL, or null if storage is not available
 */
export async function uploadImage(
  data: Buffer,
  options: {
    /** Source document ID (for organizing in storage) */
    documentId?: string;
    /** Original source URL (for content type detection) */
    sourceUrl?: string;
    /** Override content type */
    contentType?: string;
    /** Custom key prefix (default: "images") */
    prefix?: string;
  } = {}
): Promise<UploadResult | null> {
  const client = getS3Client();
  if (!client) {
    logger.debug("Storage not available, skipping image upload");
    return null;
  }

  const contentType = options.contentType || detectContentType(data, options.sourceUrl);
  const extension = getExtension(contentType);
  const uuid = randomUUID();

  // Build the storage key
  // Format: images/{docId}/{uuid}.{ext} or images/{uuid}.{ext}
  const prefix = options.prefix || "images";
  const key = options.documentId
    ? `${prefix}/${options.documentId}/${uuid}.${extension}`
    : `${prefix}/${uuid}.${extension}`;

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: storageConfig.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        // Set cache control for public caching
        CacheControl: "public, max-age=31536000, immutable",
      })
    );

    const url = getPublicUrl(key);

    logger.debug("Image uploaded to storage", {
      key,
      contentType,
      size: data.length,
    });

    return {
      key,
      url,
      contentType,
      size: data.length,
    };
  } catch (error) {
    logger.error("Failed to upload image to storage", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Fetches an image from a URL and uploads it to storage.
 *
 * @param imageUrl - The URL of the image to fetch
 * @param options - Upload options
 * @returns Upload result with new URL, or null if fetch or upload fails
 */
export async function fetchAndUploadImage(
  imageUrl: string,
  options: {
    /** Source document ID (for organizing in storage) */
    documentId?: string;
    /** Custom key prefix (default: "images") */
    prefix?: string;
    /** Timeout in milliseconds (default: 30000) */
    timeout?: number;
    /** Authorization header for the request */
    authorization?: string;
  } = {}
): Promise<UploadResult | null> {
  if (!isStorageAvailable()) {
    logger.debug("Storage not available, skipping image fetch");
    return null;
  }

  const timeout = options.timeout || 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const headers: Record<string, string> = {
      "User-Agent": "LionReader/1.0 (+https://lionreader.com)",
    };

    if (options.authorization) {
      headers["Authorization"] = options.authorization;
    }

    const response = await fetch(imageUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("Failed to fetch image", {
        url: imageUrl,
        status: response.status,
      });
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const data = Buffer.from(arrayBuffer);

    // Get content type from response or detect from data
    const contentType =
      response.headers.get("content-type")?.split(";")[0] ||
      detectContentType(data, imageUrl);

    return uploadImage(data, {
      documentId: options.documentId,
      sourceUrl: imageUrl,
      contentType,
      prefix: options.prefix,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.warn("Image fetch timed out", { url: imageUrl });
    } else {
      logger.warn("Failed to fetch image", {
        url: imageUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
