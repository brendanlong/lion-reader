/**
 * Enhanced (Phonon) voices in the browser: each sentence is synthesized on the
 * device, encoded to fragmented MP4 here (see `./audio-encoding`), and played
 * through a {@link MediaSourcePlayer} like cloud voices are.
 *
 * @module narration/phonon-speech
 */

import { loadSegmentEncoder, withTrailingSilence, type SegmentEncoder } from "./audio-encoding";
import { getMediaSourceClass, MediaSourcePlayer, UNSUPPORTED_MESSAGE } from "./media-source-player";
import { splitIntoSentenceChunks } from "./speech-chunks";
import { synthesizePhonon } from "./phonon-tts";

export interface PhononVoice {
  voice: string;
  sentenceGapSeconds: number;
}

/** A player for Phonon voices; `voice` is read for each sentence it synthesizes. */
export function createPhononSpeechPlayer(voice: () => PhononVoice): MediaSourcePlayer {
  let encoder: Promise<SegmentEncoder> | null = null;
  const getEncoder = () => {
    encoder ??= (async () => {
      const mediaSource = getMediaSourceClass();
      const loaded = mediaSource ? await loadSegmentEncoder(mediaSource) : null;
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
      const audio = await synthesizePhonon(text, voiceId, signal);
      yield await (await getEncoder()).encode(withTrailingSilence(audio, sentenceGapSeconds));
    },
    // The encoder picks the format: AAC where it can, else Opus.
    loadMimeType: async () => (await getEncoder()).mimeType,
    chunkParagraphs: splitIntoSentenceChunks,
    // One model in one worker: it generates one sentence at a time anyway.
    maxConcurrentSyntheses: 1,
  });
}
