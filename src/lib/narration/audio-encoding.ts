/**
 * Turns speech synthesized in the browser (Phonon) into fragmented MP4 as it's
 * generated, which {@link MediaSourcePlayer} appends to one Media Source
 * Extensions stream as it arrives. Cloud voices arrive from the server already
 * in that form, as AAC.
 *
 * AAC in MP4 is the only format every MSE implementation accepts — iOS's
 * `ManagedMediaSource` refuses MP3 and Opus-in-MP4. We prefer the browser's
 * native encoder (WebCodecs), use native Opus where AAC isn't offered but MSE
 * can play Opus (Chrome and Firefox on Linux), and only then fall back to a
 * WASM AAC encoder (~1 MB, loaded on demand; Safari before 26 has MSE but no
 * `AudioEncoder`).
 *
 * Mediabunny is imported lazily so it stays out of the main bundle.
 *
 * @module narration/audio-encoding
 */

import type { AudioCodec } from "mediabunny";
import { AAC_MIME_TYPE } from "./media-source-player";

export interface SpeechEncoder {
  /** MIME type (with codec) for `MediaSource.addSourceBuffer`. */
  mimeType: string;
  /**
   * Encodes one chunk of mono speech (samples in [-1, 1]) as one fragmented
   * MP4, yielding its bytes as the encoder writes them: the init segment, then
   * a fragment per {@link FRAGMENT_SECONDS} of audio, so playback can start
   * long before the chunk is finished.
   */
  encode(pcm: AsyncIterable<Float32Array>, sampleRate: number): AsyncGenerator<Uint8Array>;
}

/** Plenty for mono speech; keeps an hour of narration around 20 MB. */
const BITRATE = 48_000;

/** Short, so a chunk starts playing soon after its first audio is generated. */
const FRAGMENT_SECONDS = 0.25;

interface Candidate {
  codec: AudioCodec;
  mimeType: string;
  /** Mediabunny picks HE-AAC at ≤24 kHz by default; plain AAC-LC decodes everywhere. */
  fullCodecString?: string;
  /** Tried in order; some native AAC encoders (Windows) only take 44.1/48 kHz. */
  sampleRates: number[];
}

const AAC: Candidate = {
  codec: "aac",
  mimeType: AAC_MIME_TYPE,
  fullCodecString: "mp4a.40.2",
  sampleRates: [24_000, 48_000],
};
const OPUS: Candidate = {
  codec: "opus",
  mimeType: 'audio/mp4; codecs="opus"',
  sampleRates: [48_000],
};

/**
 * Picks the best format this browser can both encode and play through MSE.
 * Resolves null when there is none.
 */
export async function loadSpeechEncoder(
  mediaSource: typeof MediaSource
): Promise<SpeechEncoder | null> {
  const mediabunny = await import("mediabunny");
  const canPlay = (candidate: Candidate) => mediaSource.isTypeSupported(candidate.mimeType);

  for (const candidate of [AAC, OPUS]) {
    if (!canPlay(candidate)) continue;
    for (const sampleRate of candidate.sampleRates) {
      const supported = await mediabunny.canEncodeAudio(candidate.codec, {
        numberOfChannels: 1,
        sampleRate,
        quality: new mediabunny.Quality({ bitrate: BITRATE }),
      });
      if (supported) return createEncoder(mediabunny, candidate, sampleRate);
    }
  }

  if (!canPlay(AAC)) return null;
  const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
  registerAacEncoder();
  return createEncoder(mediabunny, AAC, AAC.sampleRates[0]);
}

function concat(pieces: Uint8Array[]): Uint8Array {
  if (pieces.length === 1) return pieces[0];
  const joined = new Uint8Array(pieces.reduce((length, piece) => length + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    joined.set(piece, offset);
    offset += piece.length;
  }
  return joined;
}

/**
 * `pcm` at `to` Hz, piece by piece. Mediabunny's own resampler (its
 * `transform`) holds 5 s of audio before emitting any, which would swallow
 * most sentences whole; this is the same linear interpolation without the
 * buffer.
 */
export async function* resample(
  pcm: AsyncIterable<Float32Array>,
  from: number,
  to: number
): AsyncGenerator<Float32Array> {
  if (from === to) {
    yield* pcm;
    return;
  }
  const step = from / to;
  // The last input sample seen, which the next piece interpolates from.
  let previous: number | null = null;
  // Input index of `previous`, and source position of the next output sample.
  let previousIndex = -1;
  let position = 0;
  for await (const piece of pcm) {
    if (piece.length === 0) continue;
    const firstIndex = previousIndex + 1;
    const lastIndex = firstIndex + piece.length - 1;
    const at = (index: number) => (index < firstIndex ? previous! : piece[index - firstIndex]);
    const count = Math.max(0, Math.floor((lastIndex - position) / step) + 1);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++, position += step) {
      const lower = Math.floor(position);
      const fraction = position - lower;
      out[i] = fraction === 0 ? at(lower) : at(lower) + fraction * (at(lower + 1) - at(lower));
    }
    previous = piece[piece.length - 1];
    previousIndex = lastIndex;
    if (count > 0) yield out;
  }
}

function createEncoder(
  mediabunny: typeof import("mediabunny"),
  candidate: Candidate,
  sampleRate: number
): SpeechEncoder {
  return {
    mimeType: candidate.mimeType,
    async *encode(pcm, pcmSampleRate) {
      const written: Uint8Array[] = [];
      let wake: (() => void) | null = null;
      const output = new mediabunny.Output({
        format: new mediabunny.Mp4OutputFormat({
          fastStart: "fragmented",
          minimumFragmentDuration: FRAGMENT_SECONDS,
        }),
        target: new mediabunny.StreamTarget(
          new WritableStream({
            write: (chunk) => {
              written.push(chunk.data);
              wake?.();
            },
          })
        ),
      });
      const source = new mediabunny.AudioSampleSource({
        codec: candidate.codec,
        fullCodecString: candidate.fullCodecString,
        quality: new mediabunny.Quality({ bitrate: BITRATE }),
      });
      output.addAudioTrack(source);

      let finished = false;
      let failure: unknown = null;
      const feeding = (async () => {
        await output.start();
        let timestamp = 0;
        for await (const samples of resample(pcm, pcmSampleRate, sampleRate)) {
          const sample = new mediabunny.AudioSample({
            data: samples,
            format: "f32",
            numberOfChannels: 1,
            sampleRate,
            timestamp,
          });
          timestamp += samples.length / sampleRate;
          try {
            await source.add(sample);
          } finally {
            sample.close();
          }
        }
        await output.finalize();
      })().then(
        () => (finished = true),
        (error: unknown) => (failure = error)
      );
      void feeding.finally(() => wake?.());

      try {
        for (;;) {
          if (written.length > 0) yield concat(written.splice(0));
          else if (failure) throw failure;
          else if (finished) return;
          else await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
        }
      } finally {
        if (!finished && !failure) void output.cancel().catch(() => {});
      }
    },
  };
}
