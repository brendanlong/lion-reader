/**
 * The browser's speech encoder, through the WASM AAC encoder it falls back to
 * where WebCodecs can't encode (Node has no `AudioEncoder`, like Safari before
 * 26).
 */

import { describe, it, expect } from "vitest";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { loadSpeechEncoder, resample } from "@/lib/narration/audio-encoding";

/** What the encoder runs at here (the WASM AAC encoder's rate). */
const ENCODER_RATE = 24_000;

/** MSE that can play anything. */
const mediaSource = { isTypeSupported: () => true } as unknown as typeof MediaSource;

function tone(samples: number): Float32Array {
  return Float32Array.from({ length: samples }, (_, i) => 0.3 * Math.sin(i / 10));
}

function concat(pieces: Float32Array[]): Float32Array;
function concat(pieces: Uint8Array[]): Uint8Array;
function concat(pieces: (Float32Array | Uint8Array)[]): Float32Array | Uint8Array {
  const length = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const joined =
    pieces[0] instanceof Float32Array ? new Float32Array(length) : new Uint8Array(length);
  let offset = 0;
  for (const piece of pieces) {
    joined.set(piece, offset);
    offset += piece.length;
  }
  return joined;
}

async function* piecesOf(samples: Float32Array, size: number): AsyncGenerator<Float32Array> {
  for (let i = 0; i < samples.length; i += size) yield samples.subarray(i, i + size);
}

async function collect(pcm: AsyncIterable<Float32Array>): Promise<Float32Array> {
  const pieces: Float32Array[] = [];
  for await (const piece of pcm) pieces.push(piece);
  return concat(pieces);
}

describe("loadSpeechEncoder", () => {
  it.each([
    { name: "at the encoder's rate", inputRate: ENCODER_RATE },
    { name: "resampled", inputRate: 16_000 },
  ])("yields audio fragments while the speech is still arriving ($name)", async ({ inputRate }) => {
    const encoder = await loadSpeechEncoder(mediaSource);
    if (!encoder) throw new Error("no encoder");

    const piece = inputRate * 0.08; // Phonon's 80 ms pieces
    const totalPieces = 50; // 4 s
    let piecesGenerated = 0;
    async function* speech(): AsyncGenerator<Float32Array> {
      for (; piecesGenerated < totalPieces; piecesGenerated++) yield tone(piece);
    }

    const output: Uint8Array[] = [];
    let generatedAtFirstAudio: number | null = null;
    for await (const bytes of encoder.encode(speech(), inputRate)) {
      output.push(bytes);
      // Past the init segment: a fragment with audio in it.
      if (output.length > 1) generatedAtFirstAudio ??= piecesGenerated;
    }

    // Within about a second of audio, not the whole 4 s.
    expect(generatedAtFirstAudio).not.toBeNull();
    expect(generatedAtFirstAudio!).toBeLessThan(totalPieces / 4);
    const input = new Input({ source: new BufferSource(concat(output)), formats: ALL_FORMATS });
    const duration = await input.computeDuration();
    const spoken = (totalPieces * piece) / inputRate;
    // AAC pads the end to whole 1024-sample frames, plus its priming frame.
    const aacFrame = 1024 / ENCODER_RATE;
    expect(duration).toBeGreaterThanOrEqual(spoken - 1 / inputRate);
    expect(duration).toBeLessThanOrEqual(spoken + 2 * aacFrame);
  });

  it("stops consuming the speech when its reader stops", async () => {
    const encoder = await loadSpeechEncoder(mediaSource);
    if (!encoder) throw new Error("no encoder");

    let piecesGenerated = 0;
    async function* endless(): AsyncGenerator<Float32Array> {
      for (;;) {
        piecesGenerated++;
        yield tone(ENCODER_RATE * 0.08);
      }
    }

    for await (const bytes of encoder.encode(endless(), ENCODER_RATE)) {
      expect(bytes.length).toBeGreaterThan(0);
      break;
    }
    const afterStop = piecesGenerated;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(piecesGenerated - afterStop).toBeLessThanOrEqual(1);
  });
});

describe("resample", () => {
  it.each([
    { from: 24_000, to: 48_000 },
    { from: 24_000, to: 44_100 },
    { from: 48_000, to: 24_000 },
  ])("keeps a ramp a ramp, $from → $to Hz", async ({ from, to }) => {
    const input = Float32Array.from({ length: from / 10 }, (_, i) => i / from);
    const output = await collect(resample(piecesOf(input, 1920), from, to));

    // The duration survives, to within one input sample.
    expect(Math.abs(output.length / to - input.length / from)).toBeLessThanOrEqual(1 / from);
    // Linear interpolation of a ramp is the ramp, at the output's times.
    output.forEach((value, i) => expect(value).toBeCloseTo(i / to, 6));
  });

  it("doesn't depend on how the input is split into pieces", async () => {
    const input = tone(24_000);
    const whole = await collect(resample(piecesOf(input, input.length), 24_000, 44_100));
    const pieced = await collect(resample(piecesOf(input, 7), 24_000, 44_100));
    expect(pieced).toEqual(whole);
  });

  it("passes audio already at the rate through untouched", async () => {
    const input = tone(1000);
    expect(await collect(resample(piecesOf(input, 300), 24_000, 24_000))).toEqual(input);
  });
});
