import { describe, it, expect } from "vitest";
import { ENHANCED_VOICES, resolveEnhancedVoice } from "@/lib/narration/enhanced-voices";

describe("resolveEnhancedVoice", () => {
  it("returns the voice an id names", () => {
    for (const voice of ENHANCED_VOICES) {
      expect(resolveEnhancedVoice(voice.id)).toBe(voice);
    }
  });

  it("falls back to an offered voice for null or an id we don't offer", () => {
    const fallback = resolveEnhancedVoice(null);
    expect(ENHANCED_VOICES).toContain(fallback);
    // A Piper voice id a user picked before enhanced voices moved to Phonon.
    expect(resolveEnhancedVoice("en_US-lessac-medium")).toBe(fallback);
  });
});

describe("ENHANCED_VOICES", () => {
  it("has unique ids, which telemetry labels and settings key on", () => {
    const ids = ENHANCED_VOICES.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
