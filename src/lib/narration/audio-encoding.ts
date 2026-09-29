/**
 * Turns synthesized speech into self-contained fragmented-MP4 segments that
 * {@link MediaSourcePlayer} appends to one Media Source Extensions stream.
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

/** Mono speech samples in [-1, 1]. */
export interface PcmAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface SegmentEncoder {
  /** MIME type (with codec) for `MediaSource.addSourceBuffer`. */
  mimeType: string;
  /** Encodes one chunk as a complete fragmented MP4 (init segment + fragments). */
  encode(audio: PcmAudio): Promise<Uint8Array>;
}

/** Plenty for mono speech; keeps an hour of narration around 20 MB. */
const BITRATE = 48_000;

/** Kokoro's native rate, and an AAC rate every encoder we've seen accepts. */
const DECODE_SAMPLE_RATE = 24_000;

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
  mimeType: 'audio/mp4; codecs="mp4a.40.2"',
  fullCodecString: "mp4a.40.2",
  sampleRates: [24_000, 48_000],
};
const OPUS: Candidate = {
  codec: "opus",
  mimeType: 'audio/mp4; codecs="opus"',
  sampleRates: [48_000],
};

interface ManagedMediaSourceGlobal {
  ManagedMediaSource?: typeof MediaSource;
}

/**
 * The MSE implementation to use: iPhone Safari only has `ManagedMediaSource`
 * (17.1+); everything else has `MediaSource`. Null when neither exists.
 */
export function getMediaSourceClass(): typeof MediaSource | null {
  if (typeof window === "undefined") return null;
  return (
    (window as ManagedMediaSourceGlobal).ManagedMediaSource ??
    (typeof MediaSource === "undefined" ? null : MediaSource)
  );
}

/**
 * Picks the best format this browser can both encode and play through MSE.
 * Resolves null when there is none.
 */
export async function loadSegmentEncoder(
  mediaSource: typeof MediaSource
): Promise<SegmentEncoder | null> {
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

function createEncoder(
  mediabunny: typeof import("mediabunny"),
  candidate: Candidate,
  sampleRate: number
): SegmentEncoder {
  return {
    mimeType: candidate.mimeType,
    async encode(audio: PcmAudio): Promise<Uint8Array> {
      const target = new mediabunny.BufferTarget();
      const output = new mediabunny.Output({
        format: new mediabunny.Mp4OutputFormat({ fastStart: "fragmented" }),
        target,
      });
      const source = new mediabunny.AudioSampleSource({
        codec: candidate.codec,
        fullCodecString: candidate.fullCodecString,
        quality: new mediabunny.Quality({ bitrate: BITRATE }),
        transform: { sampleRate, numberOfChannels: 1 },
      });
      output.addAudioTrack(source);
      await output.start();
      const sample = new mediabunny.AudioSample({
        data: audio.samples,
        format: "f32",
        numberOfChannels: 1,
        sampleRate: audio.sampleRate,
        timestamp: 0,
      });
      try {
        await source.add(sample);
      } finally {
        sample.close();
      }
      await output.finalize();
      if (!target.buffer) throw new Error("Audio encoder produced no output");
      return new Uint8Array(target.buffer);
    },
  };
}

/**
 * Decodes a compressed clip (e.g. a cloud voice's MP3) to mono samples with
 * the browser's own decoder. An `OfflineAudioContext` needs no user gesture,
 * unlike a realtime `AudioContext`.
 */
export async function decodeToPcm(bytes: Uint8Array): Promise<PcmAudio> {
  const context = new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE);
  const buffer = await context.decodeAudioData(bytes.slice().buffer);
  const samples = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) samples[i] += data[i] / buffer.numberOfChannels;
  }
  return { samples, sampleRate: buffer.sampleRate };
}

export function withTrailingSilence(audio: PcmAudio, seconds: number): PcmAudio {
  const samples = new Float32Array(audio.samples.length + Math.round(seconds * audio.sampleRate));
  samples.set(audio.samples);
  return { samples, sampleRate: audio.sampleRate };
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
