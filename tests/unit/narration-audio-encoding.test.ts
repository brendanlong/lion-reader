/**
 * The browser's speech encoder, through the WASM AAC encoder it falls back to
 * where WebCodecs can't encode (Node has no `AudioEncoder`, like Safari before
 * 26).
 */

import { describe, it, expect } from "vitest";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { loadSpeechEncoder } from "@/lib/narration/audio-encoding";

const SAMPLE_RATE = 24_000;
/** Phonon's piece size: 80 ms. */
const PIECE = SAMPLE_RATE * 0.08;

/** MSE that can play anything. */
const mediaSource = { isTypeSupported: () => true } as unknown as typeof MediaSource;

function tone(samples: number): Float32Array {
  return Float32Array.from({ length: samples }, (_, i) => 0.3 * Math.sin(i / 10));
}

function concat(pieces: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(pieces.reduce((length, piece) => length + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    joined.set(piece, offset);
    offset += piece.length;
  }
  return joined;
}

describe("loadSpeechEncoder", () => {
  it("yields playable MP4 before the speech has finished", async () => {
    const encoder = await loadSpeechEncoder(mediaSource);
    if (!encoder) throw new Error("no encoder");

    let piecesGenerated = 0;
    const totalPieces = 50; // 4 s
    async function* speech(): AsyncGenerator<Float32Array> {
      for (; piecesGenerated < totalPieces; piecesGenerated++) yield tone(PIECE);
    }

    const output: Uint8Array[] = [];
    let generatedAtFirstBytes: number | null = null;
    for await (const bytes of encoder.encode(speech(), SAMPLE_RATE)) {
      generatedAtFirstBytes ??= piecesGenerated;
      output.push(bytes);
    }

    expect(generatedAtFirstBytes).toBeLessThan(totalPieces);
    const input = new Input({ source: new BufferSource(concat(output)), formats: ALL_FORMATS });
    const duration = await input.computeDuration();
    // AAC pads the end to whole 1024-sample frames, plus its priming frame.
    const aacFrame = 1024 / SAMPLE_RATE;
    expect(duration).toBeGreaterThanOrEqual((totalPieces * PIECE) / SAMPLE_RATE);
    expect(duration).toBeLessThanOrEqual((totalPieces * PIECE) / SAMPLE_RATE + 2 * aacFrame);
  });

  it("stops consuming the speech when its reader stops", async () => {
    const encoder = await loadSpeechEncoder(mediaSource);
    if (!encoder) throw new Error("no encoder");

    let piecesGenerated = 0;
    async function* endless(): AsyncGenerator<Float32Array> {
      for (;;) {
        piecesGenerated++;
        yield tone(PIECE);
      }
    }

    for await (const bytes of encoder.encode(endless(), SAMPLE_RATE)) {
      expect(bytes.length).toBeGreaterThan(0);
      break;
    }
    const afterStop = piecesGenerated;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(piecesGenerated - afterStop).toBeLessThanOrEqual(1);
  });
});
