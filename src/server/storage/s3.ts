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
 * Whether the private archive bucket is configured (see the Archive section).
 */
export function isArchiveAvailable(): boolean {
  return !!(
    storageConfig.archiveBucket &&
    // The other bucket is public, and archived keys are guessable.
    storageConfig.archiveBucket !== storageConfig.bucket &&
    storageConfig.accessKeyId &&
    storageConfig.secretAccessKey
  );
}

/**
 * Lazily initialized AWS SigV4 signer (aws4fetch). Both buckets share the
 * credentials.
 */
let s3Client: AwsClient | null = null;

/**
 * Gets or creates the S3 client.
 */
function getS3Client(): AwsClient | null {
  if (!storageConfig.accessKeyId || !storageConfig.secretAccessKey) {
    return null;
  }

  if (s3Client) {
    return s3Client;
  }

  s3Client = new AwsClient({
    accessKeyId: storageConfig.accessKeyId,
    secretAccessKey: storageConfig.secretAccessKey,
    service: "s3",
    region: storageConfig.region,
    // aws4fetch defaults to 10 retries; cap it lower since image uploads are
    // best-effort and the caller already handles a null result.
    retries: 2,
  });

  return s3Client;
}

/**
 * Builds the request URL for a bucket, optionally for an object key in it.
 *
 * Mirrors the previous AWS SDK addressing: path-style when a custom endpoint
 * is configured (Tigris requires it), virtual-hosted style for plain AWS S3.
 */
function getObjectRequestUrl(bucket: string, key = ""): string {
  if (storageConfig.endpoint) {
    const base = storageConfig.endpoint.replace(/\/$/, "");
    return `${base}/${bucket}/${key}`;
  }

  return `https://${bucket}.s3.${storageConfig.region}.amazonaws.com/${key}`;
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
  if (!client || !isStorageAvailable()) {
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
  const response = await client.fetch(getObjectRequestUrl(storageConfig.bucket!, key), {
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
  await ensureOk(response, "PUT");
}

function requireS3Client(): AwsClient {
  const client = getS3Client();
  if (!client || !isStorageAvailable())
    throw new Error("Object storage isn't configured (STORAGE_* env vars)");
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
// Archive (private bucket)
// ============================================================================

/**
 * Timeout for one archive request. Archiving happens inline in full-content
 * fetches, which mustn't hang on a stalled store.
 */
const ARCHIVE_REQUEST_TIMEOUT_MS = 30000;

function requireArchive(): { client: AwsClient; bucket: string } {
  const client = getS3Client();
  if (!client || !isArchiveAvailable()) {
    throw new Error("The archive bucket isn't configured (STORAGE_ARCHIVE_BUCKET)");
  }
  return { client, bucket: storageConfig.archiveBucket! };
}

async function ensureOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  const detail = await response.text().catch(() => "");
  throw new Error(`S3 ${action} failed with status ${response.status}: ${detail.slice(0, 200)}`);
}

/**
 * Stores `data` under `key` in the archive bucket (idempotent); throws if the
 * archive isn't configured or refuses.
 */
export async function putArchiveObject(
  key: string,
  data: Uint8Array,
  contentType: string
): Promise<void> {
  const { client, bucket } = requireArchive();
  const response = await client.fetch(getObjectRequestUrl(bucket, key), {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(data.byteLength),
    },
    body: data as Uint8Array<ArrayBuffer>,
    signal: AbortSignal.timeout(ARCHIVE_REQUEST_TIMEOUT_MS),
  });
  await ensureOk(response, "PUT");
}

/** Deletes `key` from the archive bucket; deleting a missing key succeeds. */
export async function deleteArchiveObject(key: string): Promise<void> {
  const { client, bucket } = requireArchive();
  const response = await client.fetch(getObjectRequestUrl(bucket, key), {
    method: "DELETE",
    signal: AbortSignal.timeout(ARCHIVE_REQUEST_TIMEOUT_MS),
  });
  await ensureOk(response, "DELETE");
}

interface ListObjectsPage {
  keys: string[];
  nextContinuationToken: string | null;
}

function parseListObjectsV2(xml: string): ListObjectsPage {
  const keys: string[] = [];
  let nextContinuationToken: string | null = null;
  const path: string[] = [];
  let text = "";
  const parser = createSaxParser(
    {
      onopentagname(name) {
        path.push(name);
        text = "";
      },
      ontext(chunk) {
        text += chunk;
      },
      onclosetag(name) {
        const parent = path[path.length - 2];
        if (name === "Key" && parent === "Contents") keys.push(text);
        if (name === "NextContinuationToken" && parent === "ListBucketResult") {
          nextContinuationToken = text;
        }
        path.pop();
        text = "";
      },
    },
    { xmlMode: true }
  );
  parser.end(xml);
  return { keys, nextContinuationToken };
}

/** Every key under `prefix` in the archive bucket, a page (up to 1000) at a time. */
export async function* listArchiveKeys(prefix: string): AsyncGenerator<string[]> {
  const { client, bucket } = requireArchive();
  let continuationToken: string | null = null;
  do {
    const url = new URL(getObjectRequestUrl(bucket));
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    if (continuationToken) url.searchParams.set("continuation-token", continuationToken);
    const response = await client.fetch(url.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(ARCHIVE_REQUEST_TIMEOUT_MS),
    });
    await ensureOk(response, "ListObjectsV2");
    const page = parseListObjectsV2(await response.text());
    if (page.keys.length > 0) yield page.keys;
    continuationToken = page.nextContinuationToken;
  } while (continuationToken);
}
