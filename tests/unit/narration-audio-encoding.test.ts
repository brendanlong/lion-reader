/**
 * The browser's speech encoder, through the WASM AAC encoder it falls back to
 * where WebCodecs can't encode (Node has no `AudioEncoder`, like Safari before
 * 26).
 */

import { describe, it, expect, vi } from "vitest";
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

/** Whether `bytes` holds an MP4 fragment (`moof`), i.e. audio, not just the init segment. */
function hasFragment(bytes: Uint8Array): boolean {
  return Buffer.from(bytes).includes("moof");
}

async function collect(pcm: AsyncIterable<Float32Array>): Promise<Float32Array> {
  const pieces: Float32Array[] = [];
  for await (const piece of pcm) pieces.push(piece);
  return concat(pieces);
}

describe("loadSpeechEncoder", () => {
  it.each([
    { name: "at the encoder's rate", inputRate: ENCODER_RATE },
    // Doubled, like Phonon's 24 kHz into an encoder that only takes 48 kHz (this one runs at 24 kHz).
    { name: "resampled", inputRate: 12_000 },
  ])("yields audio fragments while the speech is still arriving ($name)", async ({ inputRate }) => {
    const encoder = await loadSpeechEncoder(mediaSource, ENCODER_RATE);
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
      if (hasFragment(bytes)) generatedAtFirstAudio ??= piecesGenerated;
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

  it("stops the speech as soon as its reader stops, even mid-wait", async () => {
    const encoder = await loadSpeechEncoder(mediaSource, ENCODER_RATE);
    if (!encoder) throw new Error("no encoder");

    let returned = false;
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => (release = resolve));
    async function* speech(): AsyncGenerator<Float32Array> {
      try {
        // Enough for a first fragment, then wait like Phonon between pieces.
        for (let i = 0; i < 10; i++) yield tone(ENCODER_RATE * 0.08);
        await stalled;
        yield tone(ENCODER_RATE * 0.08);
      } finally {
        returned = true;
      }
    }

    for await (const bytes of encoder.encode(speech(), ENCODER_RATE)) {
      if (hasFragment(bytes)) break;
    }
    await vi.waitFor(() => expect(returned).toBe(true), { timeout: 1000 });
    release();
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

  it.each([
    { from: 24_000, to: 44_100 },
    { from: 22_050, to: 48_000 },
    { from: 48_000, to: 44_100 },
  ])(
    "doesn't depend on how the input is split into pieces, $from → $to Hz",
    async ({ from, to }) => {
      const input = tone(from / 2);
      const whole = await collect(resample(piecesOf(input, input.length), from, to));
      // Seeded, so a failure reproduces.
      let seed = 1;
      const random = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
      for (let run = 0; run < 50; run++) {
        async function* randomPieces(): AsyncGenerator<Float32Array> {
          for (let i = 0; i < input.length;) {
            const size = 1 + Math.floor(random() * 300);
            yield input.subarray(i, i + size);
            i += size;
          }
        }
        const pieced = await collect(resample(randomPieces(), from, to));
        expect(pieced.length).toBe(whole.length);
        // The first sample that differs (or isn't a number), if any: far cheaper than toEqual
        // on arrays this long, which made the test slow enough to time out under load.
        expect(pieced.findIndex((value, i) => !Number.isFinite(value) || value !== whole[i])).toBe(
          -1
        );
      }
    }
  );

  it("passes audio already at the rate through untouched", async () => {
    const input = tone(1000);
    expect(await collect(resample(piecesOf(input, 300), 24_000, 24_000))).toEqual(input);
  });
});
