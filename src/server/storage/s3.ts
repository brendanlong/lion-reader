/**
 * S3-compatible Object Storage
 *
 * Provides functions for uploading and managing files in S3-compatible storage.
 * Works with AWS S3, Fly.io Tigris, and other S3-compatible services.
 */

import { AwsClient } from "aws4fetch";
import { storageConfig } from "@/server/config/env";
import { createSaxParser } from "@/server/html/sax";

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
    // aws4fetch defaults to 10 retries with exponential backoff, and saves wait
    // on uploads: fail sooner, for the user to retry.
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
// Upload
// ============================================================================

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

// ============================================================================
// Archive (private bucket), listing and deletion
// ============================================================================

/**
 * Timeout for one request below. Archiving happens inline in full-content
 * fetches, which mustn't hang on a stalled store.
 */
const ARCHIVE_REQUEST_TIMEOUT_MS = 30000;

/** A bucket to list or delete from: the public one, or the private archive. */
export type BucketName = "public" | "archive";

function requireBucket(which: BucketName): { client: AwsClient; bucket: string } {
  if (which === "public") return { client: requireS3Client(), bucket: storageConfig.bucket! };
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
  const { client, bucket } = requireBucket("archive");
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

/**
 * `key`'s bytes and content type from the public bucket, or null if there's no
 * such object.
 */
export async function getPublicObject(
  key: string
): Promise<{ data: Buffer; contentType: string | null } | null> {
  const { client, bucket } = requireBucket("public");
  const response = await client.fetch(getObjectRequestUrl(bucket, key), {
    method: "GET",
    signal: AbortSignal.timeout(ARCHIVE_REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  await ensureOk(response, "GET");
  return {
    data: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type"),
  };
}

/** Deletes `key`; deleting a missing key succeeds. */
export async function deleteObject(which: BucketName, key: string): Promise<void> {
  const { client, bucket } = requireBucket(which);
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

/** Every key under `prefix`, a page (up to 1000) at a time. */
export async function* listKeys(which: BucketName, prefix: string): AsyncGenerator<string[]> {
  const { client, bucket } = requireBucket(which);
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

/**
 * Deletes every object under `prefix` (idempotent), returning how many. Throws
 * if the bucket isn't configured or refuses, so a job can retry.
 */
export async function deleteObjectsWithPrefix(which: BucketName, prefix: string): Promise<number> {
  let deleted = 0;
  for await (const keys of listKeys(which, prefix)) {
    for (const key of keys) {
      await deleteObject(which, key);
      deleted++;
    }
  }
  return deleted;
}
