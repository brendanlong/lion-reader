/**
 * Enhanced (Piper) voices in the browser: each sentence is synthesized on the
 * device, encoded to fragmented MP4 here (see `./audio-encoding`), and played
 * through a {@link MediaSourcePlayer} like cloud voices are.
 *
 * @module narration/piper-speech
 */

import {
  decodeToPcm,
  getMediaSourceClass,
  loadSegmentEncoder,
  withTrailingSilence,
  type SegmentEncoder,
} from "./audio-encoding";
import {
  MediaSourcePlayer,
  splitIntoSentenceChunks,
  UNSUPPORTED_MESSAGE,
} from "./media-source-player";
import { getPiperTTSProvider } from "./piper-tts-provider";

export interface PiperVoice {
  voice: string | null;
  sentenceGapSeconds: number;
}

/** A player for Piper voices; `voice` is read for each sentence it synthesizes. */
export function createPiperSpeechPlayer(voice: () => PiperVoice): MediaSourcePlayer {
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
    synthesize: async function* (text) {
      const { voice: voiceId, sentenceGapSeconds } = voice();
      if (!voiceId) throw new Error("No enhanced voice selected");
      const wav = await getPiperTTSProvider().synthesize(text, voiceId);
      const audio = await decodeToPcm(new Uint8Array(await wav.arrayBuffer()));
      yield await (await getEncoder()).encode(withTrailingSilence(audio, sentenceGapSeconds));
    },
    // The encoder picks the format: AAC where it can, else Opus.
    loadMimeType: async () => (await getEncoder()).mimeType,
    chunkParagraphs: splitIntoSentenceChunks,
    // One WASM model on the device's CPU: one sentence at a time.
    maxConcurrentSyntheses: 1,
    // Free apart from battery, but a locked phone may synthesize slowly.
    bufferAheadSeconds: 30,
  });
}
