/**
 * Cloud voices in the browser: each chunk is streamed from `POST
 * /api/v1/narration/speech` as AAC in fragmented MP4, and its bytes go
 * straight to a {@link MediaSourcePlayer} as they arrive. Narration and the
 * voice preview both play this way.
 *
 * @module narration/cloud-speech
 */

import { z } from "zod";
import { AAC_MIME_TYPE, getMediaSourceClass } from "./audio-encoding";
import { MAX_CLOUD_SPEECH_CHARS } from "./constants";
import {
  MediaSourcePlayer,
  splitIntoSpeechChunks,
  StreamInterruptedError,
  UNSUPPORTED_MESSAGE,
} from "./media-source-player";

const SPEECH_URL = "/api/v1/narration/speech";

export interface CloudVoice {
  /** `provider:model` ref; null means the default model. */
  model: string | null;
  /** Null means the model's default voice. */
  voice: string | null;
  /** Silence after each chunk. */
  pauseSeconds: number;
}

const errorBodySchema = z.object({ message: z.string() });

/** The server's message for a refused request; it's written to be shown. */
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = errorBodySchema.safeParse(await response.json());
    if (body.success) return body.data.message;
  } catch {
    // Not JSON: a proxy's error page, say.
  }
  return `Speech synthesis failed (${response.status})`;
}

/** Times a busy answer is asked again before the chunk fails. */
const BUSY_ATTEMPTS = 5;
const BUSY_FIRST_WAIT_MS = 1_000;
const BUSY_MAX_WAIT_MS = 10_000;

/**
 * `request`'s response, asked again while the server says the voice is busy
 * (503, or our rate limit's 429), waiting as long as it asks within reason.
 * The server has already waited out a busy provider for a while, so this only
 * matters when many listeners share a provider's key.
 */
export async function fetchWhenFree(
  request: () => Promise<Response>,
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = sleep
): Promise<Response> {
  let backoff = BUSY_FIRST_WAIT_MS;
  for (let attempt = 1; ; attempt++) {
    const response = await request();
    if ((response.status !== 503 && response.status !== 429) || attempt === BUSY_ATTEMPTS) {
      return response;
    }
    const asked = Number(response.headers.get("Retry-After")) * 1000;
    await response.body?.cancel();
    await wait(
      Math.min(Number.isFinite(asked) && asked > 0 ? asked : backoff, BUSY_MAX_WAIT_MS),
      signal
    );
    backoff = Math.min(backoff * 2, BUSY_MAX_WAIT_MS);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Speaks `text`, yielding the MP4's bytes as they arrive. Throws
 * {@link StreamInterruptedError} if they stop arriving partway, so the player
 * can try the chunk again.
 */
async function* streamCloudSpeech(
  voice: CloudVoice,
  text: string,
  signal: AbortSignal
): AsyncGenerator<Uint8Array> {
  const response = await fetchWhenFree(
    () =>
      fetch(SPEECH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: voice.model,
          voice: voice.voice,
          text,
          pauseSeconds: voice.pauseSeconds,
        }),
        signal,
      }),
    signal
  );
  if (!response.ok) throw new Error(await errorMessage(response));
  if (!response.body) throw new Error("Speech synthesis returned no audio");

  const reader = response.body.getReader();
  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (signal.aborted) throw error;
        throw new StreamInterruptedError();
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // Stops the download when the player stops listening early.
    reader.cancel().catch(() => {});
  }
}

async function loadCloudMimeType(): Promise<string> {
  const mediaSource = getMediaSourceClass();
  if (!mediaSource) throw new Error(UNSUPPORTED_MESSAGE);
  // Chromium builds without proprietary codecs (some Linux distributions')
  // have MSE but no AAC.
  if (!mediaSource.isTypeSupported(AAC_MIME_TYPE)) {
    throw new Error("This browser can't play cloud voices: it doesn't support AAC audio");
  }
  return AAC_MIME_TYPE;
}

/** A player for cloud voices; `voice` is read for each chunk it synthesizes. */
export function createCloudSpeechPlayer(voice: () => CloudVoice): MediaSourcePlayer {
  return new MediaSourcePlayer({
    synthesize: (text, signal) => streamCloudSpeech(voice(), text, signal),
    loadMimeType: loadCloudMimeType,
    chunkParagraphs: (paragraphs) => splitIntoSpeechChunks(paragraphs, MAX_CLOUD_SPEECH_CHARS),
    // Each streams faster than it plays, and providers limit concurrent
    // requests per key, which several listeners share on the server's.
    maxConcurrentSyntheses: 1,
    // Paid per character, so running ahead only wastes what's left unheard.
    // With the screen locked, nothing recovers playback that stalls on an
    // empty buffer.
    bufferAheadSeconds: 60,
  });
}
