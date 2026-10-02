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
  const response = await fetch(SPEECH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: voice.model,
      voice: voice.voice,
      text,
      pauseSeconds: voice.pauseSeconds,
    }),
    signal,
  });
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
    maxConcurrentSyntheses: 4,
    // Paid per character, so running ahead only wastes what's left unheard.
    // With the screen locked, nothing recovers playback that stalls on an
    // empty buffer.
    bufferAheadSeconds: 60,
  });
}
