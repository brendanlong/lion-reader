/**
 * Which format the browser speech encoder picks, against what real browsers'
 * WebCodecs encoders and MSE accept (probed 2026-11). A file of its own:
 * mediabunny remembers each support answer for the life of the process.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { loadSpeechEncoder } from "@/lib/narration/audio-encoding";

const AAC = 'audio/mp4; codecs="mp4a.40.2"';
const OPUS = 'audio/mp4; codecs="opus"';
const PHONON_RATE = 24_000;

interface Browser {
  plays: string[];
  /** Sample rates each codec's encoder takes, by WebCodecs codec string. */
  encodes: Record<string, number[]>;
}

function asBrowser({ plays, encodes }: Browser): typeof MediaSource {
  vi.stubGlobal("AudioEncoder", {
    isConfigSupported: async (config: AudioEncoderConfig) => ({
      supported: (encodes[config.codec] ?? []).includes(config.sampleRate),
    }),
  });
  return {
    isTypeSupported: (type: string) => plays.includes(type),
  } as unknown as typeof MediaSource;
}

describe("loadSpeechEncoder's format", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("picks Opus over resampling when AAC only takes another rate (Chrome on Android)", async () => {
    const mediaSource = asBrowser({
      plays: [AAC, OPUS],
      encodes: { "mp4a.40.2": [48_000], opus: [24_000, 48_000] },
    });
    expect((await loadSpeechEncoder(mediaSource, PHONON_RATE))?.mimeType).toBe(OPUS);
  });

  it("resamples to AAC where MSE can't play Opus (iOS)", async () => {
    const mediaSource = asBrowser({
      plays: [AAC],
      encodes: { "mp4a.40.2": [48_000], opus: [24_000, 48_000] },
    });
    expect((await loadSpeechEncoder(mediaSource, PHONON_RATE))?.mimeType).toBe(AAC);
  });

  it("uses Opus where there's no AAC encoder (desktop Chromium, Firefox)", async () => {
    const mediaSource = asBrowser({
      plays: [AAC, OPUS],
      encodes: { opus: [24_000, 48_000] },
    });
    expect((await loadSpeechEncoder(mediaSource, PHONON_RATE))?.mimeType).toBe(OPUS);
  });
});
