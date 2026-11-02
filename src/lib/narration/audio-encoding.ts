/**
 * Turns speech synthesized in the browser (Phonon) into fragmented MP4 as it's
 * generated, which {@link MediaSourcePlayer} appends to one Media Source
 * Extensions stream as it arrives. Cloud voices arrive from the server already
 * in that form, as AAC.
 *
 * AAC in MP4 is the only format every MSE implementation accepts — iOS's
 * `ManagedMediaSource` refuses MP3 and Opus-in-MP4. We prefer the browser's
 * native encoder (WebCodecs) at the speech's own sample rate, so nothing is
 * resampled: AAC where it takes that rate, else Opus where MSE can play it
 * (Chrome on Android only encodes AAC at 48 kHz, but Opus at 24 kHz). Then
 * either at a rate it does take, resampled; and only then a WASM AAC encoder
 * (~1 MB, loaded on demand; Safari before 26 has MSE but no `AudioEncoder`).
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
  mediaSource: typeof MediaSource,
  speechSampleRate: number
): Promise<SpeechEncoder | null> {
  const mediabunny = await import("mediabunny");
  const playable = [AAC, OPUS].filter((candidate) =>
    mediaSource.isTypeSupported(candidate.mimeType)
  );
  const canEncode = (candidate: Candidate, sampleRate: number) =>
    mediabunny.canEncodeAudio(candidate.codec, {
      numberOfChannels: 1,
      sampleRate,
      quality: new mediabunny.Quality({ bitrate: BITRATE }),
    });

  for (const candidate of playable) {
    if (await canEncode(candidate, speechSampleRate)) {
      return createEncoder(mediabunny, candidate, speechSampleRate);
    }
  }
  for (const candidate of playable) {
    for (const sampleRate of candidate.sampleRates) {
      if (await canEncode(candidate, sampleRate)) {
        return createEncoder(mediabunny, candidate, sampleRate);
      }
    }
  }

  if (!playable.includes(AAC)) return null;
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
  // Output sample `n` sits at input position n·from/to, computed from `n`
  // each time (in integers, so exactly) rather than by adding a step, whose
  // rounding drifts past the end of a piece.
  let n = 0;
  // The last input sample seen, which the next piece interpolates from, and its index.
  let previous = 0;
  let previousIndex = -1;
  for await (const piece of pcm) {
    if (piece.length === 0) continue;
    const firstIndex = previousIndex + 1;
    const lastIndex = firstIndex + piece.length - 1;
    const at = (index: number) => (index < firstIndex ? previous : piece[index - firstIndex]);
    const out: number[] = [];
    for (; n * from <= lastIndex * to; n++) {
      const lower = Math.floor((n * from) / to);
      const remainder = n * from - lower * to;
      out.push(
        remainder === 0 ? at(lower) : at(lower) + (remainder / to) * (at(lower + 1) - at(lower))
      );
    }
    previous = piece[piece.length - 1];
    previousIndex = lastIndex;
    if (out.length > 0) yield Float32Array.from(out);
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
        // Append-only, so a write that isn't sequential throws rather than
        // corrupting what the player has appended.
        target: new mediabunny.AppendOnlyStreamTarget(
          new WritableStream({
            write: (bytes) => {
              written.push(bytes);
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

      const input = resample(pcm, pcmSampleRate, sampleRate)[Symbol.asyncIterator]();
      let stopped = false;
      let finished = false;
      let failed = false;
      let failure: unknown;
      const feeding = (async () => {
        await output.start();
        let frames = 0;
        for (let next = await input.next(); !next.done && !stopped; next = await input.next()) {
          const sample = new mediabunny.AudioSample({
            data: next.value,
            format: "f32",
            numberOfChannels: 1,
            sampleRate,
            timestamp: frames / sampleRate,
          });
          frames += next.value.length;
          try {
            await source.add(sample);
          } finally {
            sample.close();
          }
        }
        if (!stopped) await output.finalize();
      })().then(
        () => (finished = true),
        (error: unknown) => {
          failed = true;
          failure = error;
        }
      );
      void feeding.finally(() => wake?.());

      try {
        for (;;) {
          if (written.length > 0) yield concat(written.splice(0));
          else if (failed) throw failure;
          else if (finished) return;
          else await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
        }
      } finally {
        if (!finished && !failed) {
          // The reader stopped early: stop pulling speech now, not when its next piece comes.
          stopped = true;
          void input.return?.(undefined).catch(() => {});
          void output.cancel().catch(() => {});
        }
      }
    },
  };
}
