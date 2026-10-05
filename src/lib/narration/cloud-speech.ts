/**
 * Cloud voices in the browser: each chunk is streamed from `POST
 * /api/v1/narration/speech` (or, recorded ahead of time, fetched from
 * `./prerecorded-speech`) as AAC in fragmented MP4, and its bytes go straight
 * to a {@link MediaSourcePlayer} as they arrive. Narration and the voice
 * preview both play this way.
 *
 * @module narration/cloud-speech
 */

import { z } from "zod";
import { MAX_CLOUD_SPEECH_CHARS } from "./constants";
import {
  AAC_MIME_TYPE,
  getMediaSourceClass,
  MediaSourcePlayer,
  splitIntoSpeechChunks,
  StreamInterruptedError,
  type SpeechChunk,
  TransientSynthesisError,
  UNSUPPORTED_MESSAGE,
} from "./media-source-player";
import { splitNarrationParagraphs } from "./paragraph-map";
import {
  prerecordedSpeechKey,
  prerecordedSpeechUrl,
  type PrerecordedVoice,
} from "./prerecorded-speech";

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

/** Statuses worth trying again for: a timeout, our rate limit, server trouble. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** The server's "come back shortly": a busy voice (503), or our rate limit (429). */
function isBusyStatus(status: number): boolean {
  return status === 503 || status === 429;
}

/** Times a chunk is asked for while busy, before playback pauses there. */
export const BUSY_ATTEMPTS = 3;
export const BUSY_FIRST_WAIT_MS = 1_000;
const BUSY_MAX_WAIT_MS = 10_000;

/**
 * `request`'s response, asked again while the server says the voice is busy
 * ({@link isBusyStatus}), waiting as long as it asks within reason. The
 * server has already waited out a busy provider for up to 15 s of each
 * request, and then the player pauses without asking again. Other transient
 * failures (no connection, a 5xx) are one request each, which the player tries
 * three more times after waits of 17 s in all. So a chunk costs at most six
 * requests (three failures, then a busy round), each lasting at most the
 * server's speech timeout (`SPEECH_TIMEOUT_MS`, 2 min), plus 37 s of waits.
 */
export async function fetchWhenFree(
  request: () => Promise<Response>,
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = sleep
): Promise<Response> {
  let backoff = BUSY_FIRST_WAIT_MS;
  for (let attempt = 1; ; attempt++) {
    const response = await request();
    if (!isBusyStatus(response.status) || attempt === BUSY_ATTEMPTS) {
      return response;
    }
    const asked = Number(response.headers.get("Retry-After")) * 1000;
    await response.body?.cancel().catch(() => {});
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
 * The audio `request` answers with, yielding the MP4's bytes as they arrive.
 * Throws {@link StreamInterruptedError} if they stop arriving partway, so the
 * player can try the chunk again, and {@link TransientSynthesisError} for
 * trouble that may pass (no connection, a 5xx); the server's 4xx (a provider
 * refusing the key, say) end narration with its message.
 */
async function* streamSpeechResponse(
  request: () => Promise<Response>,
  signal: AbortSignal
): AsyncGenerator<Uint8Array> {
  let response: Response;
  try {
    response = await fetchWhenFree(request, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new TransientSynthesisError("Couldn't reach Lion Reader for the cloud voice");
  }
  if (!response.ok) {
    const message = await errorMessage(response);
    // fetchWhenFree has asked again for these already: the player pauses
    // rather than ask more.
    const retried = isBusyStatus(response.status);
    throw isTransientStatus(response.status)
      ? new TransientSynthesisError(message, !retried)
      : new Error(message);
  }
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

function chunkCloudSpeech(paragraphs: string[]): SpeechChunk[] {
  return splitIntoSpeechChunks(paragraphs, MAX_CLOUD_SPEECH_CHARS);
}

/** The texts a cloud voice player asks for, in order, to narrate `narration`. */
export function cloudSpeechTexts(narration: string): string[] {
  return chunkCloudSpeech(splitNarrationParagraphs(narration)).map((chunk) => chunk.text);
}

function createPlayer(
  synthesize: (text: string, signal: AbortSignal) => AsyncIterable<Uint8Array>
): MediaSourcePlayer {
  return new MediaSourcePlayer({
    synthesize,
    loadMimeType: loadCloudMimeType,
    chunkParagraphs: chunkCloudSpeech,
    // Enough that a provider streaming slower than playback (at 2x, say) can
    // keep up by generating several chunks at once, but bounded: providers
    // limit concurrent requests per key, which several listeners share on the
    // server's.
    maxConcurrentSyntheses: 4,
  });
}

/** A player for cloud voices; `voice` is read for each chunk it synthesizes. */
export function createCloudSpeechPlayer(voice: () => CloudVoice): MediaSourcePlayer {
  return createPlayer((text, signal) => {
    const { model, voice: voiceId, pauseSeconds } = voice();
    return streamSpeechResponse(
      () =>
        fetch(SPEECH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, voice: voiceId, text, pauseSeconds }),
          signal,
        }),
      signal
    );
  });
}

/**
 * A player for a cloud voice's recordings (see `./prerecorded-speech`): it
 * plays what the cloud voice player would, without synthesizing anything.
 */
export function createPrerecordedSpeechPlayer(voice: PrerecordedVoice): MediaSourcePlayer {
  return createPlayer(async function* (text, signal) {
    const key = await prerecordedSpeechKey(voice, text);
    yield* streamSpeechResponse(() => fetch(prerecordedSpeechUrl(key), { signal }), signal);
  });
}
