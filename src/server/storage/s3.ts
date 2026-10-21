/**
 * S3-compatible Object Storage
 *
 * Provides functions for uploading and managing files in S3-compatible storage.
 * Works with AWS S3, Fly.io Tigris, and other S3-compatible services.
 */

import { AwsClient } from "aws4fetch";
import { logger } from "@/lib/logger";
import { storageConfig } from "@/server/config/env";
import { randomUUID } from "crypto";
import { USER_AGENT } from "@/server/http/user-agent";
import { fetchWithSsrfProtection } from "@/server/http/ssrf";
import { readResponseBufferWithSizeLimit, ContentTooLargeError } from "@/server/http/fetch";
import { createHash } from "node:crypto";
import { escapeHtml } from "@/server/http/html";
import { createSaxParser } from "@/server/html/sax";

/**
 * Maximum size for images fetched from external URLs (20MB).
 */
const MAX_FETCHED_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;

/**
 * Timeout for fetching an external image (30 seconds).
 */
const IMAGE_FETCH_TIMEOUT_MS = 30000;

// ============================================================================
// Configuration
// ============================================================================

/**
 * Checks if object storage is configured and available.
 */
export function isStorageAvailable(): boolean {
  return !!(storageConfig.bucket && storageConfig.accessKeyId && storageConfig.secretAccessKey);
}

/**
 * Lazily initialized AWS SigV4 signer (aws4fetch).
 */
let s3Client: AwsClient | null = null;

/**
 * Gets or creates the S3 client.
 */
function getS3Client(): AwsClient | null {
  if (!isStorageAvailable()) {
    return null;
  }

  if (s3Client) {
    return s3Client;
  }

  s3Client = new AwsClient({
    accessKeyId: storageConfig.accessKeyId!,
    secretAccessKey: storageConfig.secretAccessKey!,
    service: "s3",
    region: storageConfig.region,
    // aws4fetch defaults to 10 retries; cap it lower since image uploads are
    // best-effort and the caller already handles a null result.
    retries: 2,
  });

  return s3Client;
}

/**
 * Builds the request URL for an object key.
 *
 * Mirrors the previous AWS SDK addressing: path-style when a custom endpoint
 * is configured (Tigris requires it), virtual-hosted style for plain AWS S3.
 */
function getObjectRequestUrl(key: string): string {
  if (storageConfig.endpoint) {
    const base = storageConfig.endpoint.replace(/\/$/, "");
    return `${base}/${storageConfig.bucket}/${key}`;
  }

  return `https://${storageConfig.bucket}.s3.${storageConfig.region}.amazonaws.com/${key}`;
}

/** The request URL for a bucket-level operation (listing, multi-object delete). */
function getBucketRequestUrl(query: string): string {
  if (storageConfig.endpoint) {
    const base = storageConfig.endpoint.replace(/\/$/, "");
    return `${base}/${storageConfig.bucket}?${query}`;
  }

  return `https://${storageConfig.bucket}.s3.${storageConfig.region}.amazonaws.com/?${query}`;
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
function getPublicUrl(key: string): string {
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

/**
 * The public URL of an object, or null if no bucket is configured. Reading
 * needs no credentials: the bucket is public.
 */
export function getPublicObjectUrl(key: string): string | null {
  if (!storageConfig.publicUrlBase && !storageConfig.bucket) return null;
  return getPublicUrl(key);
}

// ============================================================================
// Image Upload
// ============================================================================

/**
 * Result of uploading an image.
 */
interface UploadResult {
  /** The public URL to access the image */
  url: string;
}

/**
 * Determines content type from image data or URL.
 */
function detectContentType(data: Buffer, sourceUrl?: string): string {
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
 * Uploads an image to object storage under `{prefix}/{documentId}/{uuid}.{ext}`.
 *
 * @param data - The image data as a Buffer
 * @param contentType - The image's content type
 * @param options - Where to file the object
 * @returns Upload result with URL, or null if storage is not available
 */
async function uploadImage(
  data: Buffer,
  contentType: string,
  options: UploadLocation
): Promise<UploadResult | null> {
  const client = getS3Client();
  if (!client) {
    logger.debug("Storage not available, skipping image upload");
    return null;
  }

  const key = `${options.prefix}/${options.documentId}/${randomUUID()}.${getExtension(contentType)}`;

  try {
    await putObject(client, key, data, contentType);
    const url = getPublicUrl(key);

    logger.debug("Image uploaded to storage", {
      key,
      contentType,
      size: data.length,
    });

    return { url };
  } catch (error) {
    logger.error("Failed to upload image to storage", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Stores `data` under `key`, to be cached forever: every key we write names
 * content that never changes.
 */
async function putObject(
  client: AwsClient,
  key: string,
  data: Uint8Array,
  contentType: string
): Promise<void> {
  const response = await client.fetch(getObjectRequestUrl(key), {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      // Tigris requires it, and Next's fetch can send a typed array chunked.
      "Content-Length": String(data.byteLength),
    },
    // aws4fetch hashes the body for the SigV4 signature. Node's Buffer is a
    // Uint8Array subclass, so pass it directly without copying; the cast
    // narrows the generic's ArrayBufferLike to the ArrayBuffer that BodyInit
    // requires.
    body: data as Uint8Array<ArrayBuffer>,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`S3 PUT failed with status ${response.status}: ${detail.slice(0, 200)}`);
  }
}

function requireS3Client(): AwsClient {
  const client = getS3Client();
  if (!client) throw new Error("Object storage isn't configured (STORAGE_* env vars)");
  return client;
}

/** Stores `data` under `key`; throws if storage isn't configured or refuses. */
export async function uploadObject(
  key: string,
  data: Uint8Array,
  contentType: string
): Promise<void> {
  await putObject(requireS3Client(), key, data, contentType);
}

/**
 * Where an uploaded image is filed in storage.
 */
interface UploadLocation {
  /** Key prefix (e.g. the source service) */
  prefix: string;
  /** Source document ID (for organizing in storage) */
  documentId: string;
}

/**
 * Fetches an image from a URL and uploads it to storage.
 *
 * @param imageUrl - The URL of the image to fetch
 * @param options - Where to file the image, plus the Authorization header the
 *   fetch needs
 * @returns Upload result with new URL, or null if fetch or upload fails
 */
export async function fetchAndUploadImage(
  imageUrl: string,
  options: UploadLocation & { authorization: string }
): Promise<UploadResult | null> {
  if (!isStorageAvailable()) {
    logger.debug("Storage not available, skipping image fetch");
    return null;
  }

  try {
    // Image URLs come from external documents (e.g. Google Docs contentUri
    // values), so the fetch is SSRF-protected and size-limited.
    const response = await fetchWithSsrfProtection(imageUrl, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Authorization: options.authorization,
      },
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn("Failed to fetch image", {
        url: imageUrl,
        status: response.status,
      });
      return null;
    }

    const data = await readResponseBufferWithSizeLimit(
      response,
      MAX_FETCHED_IMAGE_SIZE_BYTES,
      imageUrl
    );

    // Get content type from response or detect from data
    const contentType =
      response.headers.get("content-type")?.split(";")[0] || detectContentType(data, imageUrl);

    return uploadImage(data, contentType, options);
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      logger.warn("Image fetch timed out", { url: imageUrl });
    } else if (error instanceof ContentTooLargeError) {
      logger.warn("Image too large, skipping", {
        url: imageUrl,
        receivedBytes: error.receivedBytes,
      });
    } else {
      logger.warn("Failed to fetch image", {
        url: imageUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

// ============================================================================
// Deletion
// ============================================================================

/** The most keys S3 lists, or deletes, in one request. */
const MAX_KEYS_PER_REQUEST = 1000;

/** The text of every element named `name` in an S3 XML response. */
function elementTexts(xml: string, name: string): string[] {
  const texts: string[] = [];
  let current: string | null = null;
  const parser = createSaxParser(
    {
      onopentag: (tag) => {
        if (tag === name) current = "";
      },
      ontext: (text) => {
        if (current !== null) current += text;
      },
      onclosetag: (tag) => {
        if (tag === name && current !== null) {
          texts.push(current);
          current = null;
        }
      },
    },
    { xmlMode: true }
  );
  parser.write(xml);
  parser.end();
  return texts;
}

async function requestXml(client: AwsClient, url: string, init: RequestInit): Promise<string> {
  const response = await client.fetch(url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `S3 ${init.method} failed with status ${response.status}: ${body.slice(0, 200)}`
    );
  }
  return body;
}

/**
 * Deletes every object whose key starts with `prefix`, returning how many.
 * Throws if storage isn't configured or refuses any of them, so a caller can
 * retry; deleting what's already gone is harmless.
 */
export async function deleteObjectsWithPrefix(prefix: string): Promise<number> {
  const client = requireS3Client();
  let deleted = 0;
  // Each pass lists the first page again: what the last one listed is gone.
  for (;;) {
    const query = new URLSearchParams({
      "list-type": "2",
      prefix,
      "max-keys": String(MAX_KEYS_PER_REQUEST),
    });
    const listing = await requestXml(client, getBucketRequestUrl(query.toString()), {
      method: "GET",
    });
    const keys = elementTexts(listing, "Key");
    if (keys.length === 0) return deleted;

    const body =
      "<Delete><Quiet>true</Quiet>" +
      keys.map((key) => `<Object><Key>${escapeHtml(key)}</Key></Object>`).join("") +
      "</Delete>";
    // Quiet: the response lists only the keys that failed.
    const result = await requestXml(client, getBucketRequestUrl("delete"), {
      method: "POST",
      headers: {
        "Content-Type": "application/xml",
        "Content-MD5": createHash("md5").update(body).digest("base64"),
      },
      body,
    });
    const failed = elementTexts(result, "Error");
    if (failed.length > 0) {
      throw new Error(`S3 refused to delete ${failed.length} objects under ${prefix}`);
    }
    deleted += keys.length;
  }
}
