/**
 * GET /api/prerecorded-speech/:key
 *
 * A chunk of the demo's narration (`@/lib/narration/prerecorded-speech`):
 * from the bucket, or, the first time it's asked for, synthesized with the
 * server's key and stored there (`@/server/services/prerecorded-speech`). The
 * player fetches it through the CDN (`ASSET_PREFIX`), which caches it: a key
 * names its content, so audio can be cached forever, while a failure isn't
 * cached. The CDN is another origin than the page, hence the CORS header.
 *
 * No auth: the demo, which has no session, is what plays these. Only keys in
 * the demo's catalog are served or synthesized, so the route can't be used to
 * speak arbitrary text.
 */

import { logger } from "@/lib/logger";
import {
  isPrerecordedSpeechKey,
  prerecordedSpeechObjectKey,
} from "@/lib/narration/prerecorded-speech";
import { USER_AGENT } from "@/server/http/user-agent";
import { demoNarrationCatalog } from "@/server/services/demo-narration";
import { createPrerecordedSpeech } from "@/server/services/prerecorded-speech";
import { ProviderBusyError } from "@/server/services/provider-errors";
import {
  SpeechRejectedError,
  SpeechRequestError,
  SpeechUnavailableError,
  streamSpeech,
} from "@/server/services/speech";
import { getPublicObjectUrl, isStorageAvailable, uploadObject } from "@/server/storage/s3";

const READ_TIMEOUT_MS = 30_000;

/** Recordings are public, and a constant value is safe to cache at the CDN. */
const CORS = { "Access-Control-Allow-Origin": "*" };

async function readStoredRecording(key: string): Promise<ReadableStream<Uint8Array> | null> {
  const url = getPublicObjectUrl(prerecordedSpeechObjectKey(key));
  if (!url) return null;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Reading a recording failed with status ${response.status}`);
  }
  return response.body;
}

const getPrerecordedSpeech = createPrerecordedSpeech({
  catalog: demoNarrationCatalog,
  read: readStoredRecording,
  // On the server's keys, so its allowlist applies. No abort signal: a chunk
  // the listener leaves halfway is still worth finishing and keeping.
  synthesize: ({ voice, text }) =>
    streamSpeech(
      {},
      {
        model: voice.model,
        voice: voice.voice,
        text,
        pauseSeconds: voice.pauseSeconds,
        userId: "demo",
      }
    ),
  store: isStorageAvailable()
    ? (key, audio) => uploadObject(prerecordedSpeechObjectKey(key), audio, "audio/mp4")
    : null,
  synthesizeUncached: process.env.NODE_ENV === "development",
});

function errorResponse(
  status: number,
  message: string,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: {
      ...CORS,
      ...headers,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string }> }
): Promise<Response> {
  const { key } = await params;
  if (!isPrerecordedSpeechKey(key)) return errorResponse(404, "No such narration");

  let audio: ReadableStream<Uint8Array> | null;
  try {
    audio = await getPrerecordedSpeech(key);
  } catch (error) {
    if (error instanceof ProviderBusyError || error instanceof SpeechUnavailableError) {
      return errorResponse(503, "The voice is busy; try again shortly", { "Retry-After": "5" });
    }
    // Shown as is: in development, where these are likely, they say what to
    // fix ("Cloud voices require an API key …").
    if (error instanceof SpeechRequestError || error instanceof SpeechRejectedError) {
      return errorResponse(422, error.message);
    }
    logger.error("Recorded narration failed", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(502, "Couldn't get the narration");
  }
  if (!audio) return errorResponse(404, "This narration hasn't been recorded");

  return new Response(audio, {
    headers: {
      ...CORS,
      "Content-Type": "audio/mp4",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
