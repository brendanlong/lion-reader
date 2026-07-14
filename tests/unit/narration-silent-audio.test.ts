/**
 * Unit tests for the silent-audio WAV generation used to activate the OS Media
 * Session while narration plays (issue #410).
 *
 * These cover the pure byte-level generator; the DOM element wiring is exercised
 * by the media-session integration test.
 */

import { describe, it, expect } from "vitest";
import { createSilentWavBytes, createSilentAudioDataUri } from "@/lib/narration/silent-audio";

/** Reads a little-endian uint32 from a byte array. */
function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)
  );
}

/** Reads a little-endian uint16 from a byte array. */
function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

/** Reads an ASCII string of the given length. */
function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

describe("createSilentWavBytes", () => {
  it("produces a well-formed RIFF/WAVE header", () => {
    const bytes = createSilentWavBytes();

    expect(readAscii(bytes, 0, 4)).toBe("RIFF");
    expect(readAscii(bytes, 8, 4)).toBe("WAVE");
    expect(readAscii(bytes, 12, 4)).toBe("fmt ");
    expect(readAscii(bytes, 36, 4)).toBe("data");
  });

  it("declares mono 8-bit PCM and consistent chunk sizes", () => {
    const durationSeconds = 0.5;
    const sampleRate = 8000;
    const bytes = createSilentWavBytes(durationSeconds, sampleRate);

    const dataSize = sampleRate * durationSeconds; // mono, 8-bit => 1 byte/sample

    expect(readUint32LE(bytes, 16)).toBe(16); // PCM fmt chunk size
    expect(readUint16LE(bytes, 20)).toBe(1); // audio format = PCM
    expect(readUint16LE(bytes, 22)).toBe(1); // channels = mono
    expect(readUint32LE(bytes, 24)).toBe(sampleRate);
    expect(readUint16LE(bytes, 34)).toBe(8); // bits per sample
    expect(readUint32LE(bytes, 40)).toBe(dataSize); // data chunk size
    expect(readUint32LE(bytes, 4)).toBe(36 + dataSize); // RIFF chunk size
    expect(bytes.length).toBe(44 + dataSize);
  });

  it("fills the sample data with 8-bit silence (unsigned midpoint 128)", () => {
    const bytes = createSilentWavBytes(0.1, 8000);
    const data = bytes.subarray(44);

    expect(data.length).toBeGreaterThan(0);
    expect(data.every((sample) => sample === 128)).toBe(true);
  });

  it("always emits at least one sample even for a zero duration", () => {
    const bytes = createSilentWavBytes(0, 8000);
    expect(bytes.length).toBe(44 + 1);
  });
});

describe("createSilentAudioDataUri", () => {
  it("returns a base64 audio/wav data URI", () => {
    const uri = createSilentAudioDataUri();
    expect(uri.startsWith("data:audio/wav;base64,")).toBe(true);
    expect(uri.length).toBeGreaterThan("data:audio/wav;base64,".length);
  });
});
