/**
 * Enhanced (Phonon) voices in the browser: each sentence is synthesized on the
 * device, encoded to fragmented MP4 as it's generated (see `./audio-encoding`),
 * and played through a {@link MediaSourcePlayer} like cloud voices are, from
 * its first fragment.
 *
 * @module narration/phonon-speech
 */

import { loadSpeechEncoder, type SpeechEncoder } from "./audio-encoding";
import { getMediaSourceClass, MediaSourcePlayer, UNSUPPORTED_MESSAGE } from "./media-source-player";
import { splitIntoSentenceChunks } from "./speech-chunks";
import { streamPhonon } from "./phonon-tts";

export interface PhononVoice {
  voice: string;
  sentenceGapSeconds: number;
}

/** `speech`, then `seconds` of silence, unless `signal` cut the speech short. */
async function* withTrailingSilence(
  speech: AsyncIterable<Float32Array>,
  sampleRate: number,
  seconds: number,
  signal: AbortSignal
): AsyncGenerator<Float32Array> {
  yield* speech;
  if (signal.aborted) return;
  const silence = Math.round(seconds * sampleRate);
  if (silence > 0) yield new Float32Array(silence);
}

/** A player for Phonon voices; `voice` is read for each sentence it synthesizes. */
export function createPhononSpeechPlayer(voice: () => PhononVoice): MediaSourcePlayer {
  let encoder: Promise<SpeechEncoder> | null = null;
  const getEncoder = () => {
    encoder ??= (async () => {
      const mediaSource = getMediaSourceClass();
      const loaded = mediaSource ? await loadSpeechEncoder(mediaSource) : null;
      if (!loaded) throw new Error(UNSUPPORTED_MESSAGE);
      return loaded;
    })().catch((error: unknown) => {
      encoder = null;
      throw error;
    });
    return encoder;
  };

  return new MediaSourcePlayer({
    synthesize: async function* (text, signal) {
      const { voice: voiceId, sentenceGapSeconds } = voice();
      const speech = await streamPhonon(text, voiceId, signal);
      const pcm = withTrailingSilence(speech, speech.sampleRate, sentenceGapSeconds, signal);
      yield* (await getEncoder()).encode(pcm, speech.sampleRate);
    },
    // The encoder picks the format: AAC where it can, else Opus.
    loadMimeType: async () => (await getEncoder()).mimeType,
    chunkParagraphs: splitIntoSentenceChunks,
    // One model in one worker: it generates one sentence at a time anyway.
    maxConcurrentSyntheses: 1,
  });
}
