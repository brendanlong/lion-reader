/**
 * GET /api/prerecorded-speech/:key
 *
 * A narration chunk recorded ahead of time (`@/lib/narration/prerecorded-speech`),
 * relayed from the public bucket. Relayed rather than fetched from the bucket
 * directly because the player reads the bytes with `fetch`, which a
 * cross-origin bucket would have to allow with CORS, and so that the CDN in
 * front of the site caches it. A key names its content, so a recording can be
 * cached forever; a missing one is not cached, since it may be recorded later.
 *
 * No auth: the demo, which has no session, is what plays these. The key is
 * checked to be a hash before it goes into the URL, so only recordings can be
 * fetched, and only from our bucket.
 */

import { logger } from "@/lib/logger";
import {
  isPrerecordedSpeechKey,
  prerecordedSpeechObjectKey,
} from "@/lib/narration/prerecorded-speech";
import { USER_AGENT } from "@/server/http/user-agent";
import { getPublicObjectUrl } from "@/server/storage/s3";

const FETCH_TIMEOUT_MS = 30_000;

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string }> }
): Promise<Response> {
  const { key } = await params;
  const url = isPrerecordedSpeechKey(key)
    ? getPublicObjectUrl(prerecordedSpeechObjectKey(key))
    : null;
  if (!url) return errorResponse(404, "This narration hasn't been recorded");

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn("Couldn't fetch recorded narration", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(502, "Couldn't fetch the recorded narration");
  }
  if (upstream.status === 404) {
    await upstream.body?.cancel().catch(() => {});
    return errorResponse(404, "This narration hasn't been recorded");
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    logger.warn("Recorded narration fetch failed", { key, status: upstream.status });
    return errorResponse(502, "Couldn't fetch the recorded narration");
  }

  const headers: Record<string, string> = {
    "Content-Type": "audio/mp4",
    "Cache-Control": "public, max-age=31536000, immutable",
  };
  const length = upstream.headers.get("content-length");
  if (length) headers["Content-Length"] = length;
  return new Response(upstream.body, { headers });
}
