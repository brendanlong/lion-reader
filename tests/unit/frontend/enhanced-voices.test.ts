/**
 * Unit tests for enhanced voice utilities.
 *
 * Tests findEnhancedVoice and isEnhancedVoice functions.
 */

import { describe, it, expect } from "vitest";
import {
  findEnhancedVoice,
  isEnhancedVoice,
  ENHANCED_VOICES,
} from "@/lib/narration/enhanced-voices";

describe("findEnhancedVoice", () => {
  describe("finding existing voices", () => {
    it("finds a voice by its exact ID", () => {
      const voice = findEnhancedVoice("en_US-lessac-medium");

      expect(voice).toBeDefined();
      expect(voice?.id).toBe("en_US-lessac-medium");
      expect(voice?.displayName).toBe("Alex (US)");
    });

    it("returns correct metadata for found voice", () => {
      const voice = findEnhancedVoice("en_US-ryan-medium");

      expect(voice).toBeDefined();
      expect(voice?.language).toBe("en-US");
      expect(voice?.gender).toBe("male");
      expect(voice?.quality).toBe("medium");
    });

    it("finds voices with different quality levels", () => {
      const lowQuality = findEnhancedVoice("en_US-amy-low");

      expect(lowQuality).toBeDefined();
      expect(lowQuality?.quality).toBe("low");
    });

    it("finds voices with different languages", () => {
      const britishVoice = findEnhancedVoice("en_GB-alba-medium");

      expect(britishVoice).toBeDefined();
      expect(britishVoice?.language).toBe("en-GB");
    });
  });

  describe("non-existent voices", () => {
    it("returns undefined for unknown voice IDs", () => {
      expect(findEnhancedVoice("nonexistent-voice")).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(findEnhancedVoice("")).toBeUndefined();
    });

    it("returns undefined for partial matches", () => {
      // Should not match partial IDs
      expect(findEnhancedVoice("en_US-lessac")).toBeUndefined();
      expect(findEnhancedVoice("lessac-medium")).toBeUndefined();
    });

    it("is case-sensitive", () => {
      expect(findEnhancedVoice("EN_US-LESSAC-MEDIUM")).toBeUndefined();
      expect(findEnhancedVoice("En_Us-Lessac-Medium")).toBeUndefined();
    });
  });
});

describe("isEnhancedVoice", () => {
  describe("valid enhanced voices", () => {
    it("returns true for known voice IDs", () => {
      expect(isEnhancedVoice("en_US-lessac-medium")).toBe(true);
      expect(isEnhancedVoice("en_US-amy-low")).toBe(true);
      expect(isEnhancedVoice("en_US-ryan-medium")).toBe(true);
      expect(isEnhancedVoice("en_GB-alba-medium")).toBe(true);
    });

    it("returns true for all voices in ENHANCED_VOICES", () => {
      for (const voice of ENHANCED_VOICES) {
        expect(isEnhancedVoice(voice.id)).toBe(true);
      }
    });
  });

  describe("non-enhanced voices", () => {
    it("returns false for unknown voice IDs", () => {
      expect(isEnhancedVoice("unknown-voice")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isEnhancedVoice("")).toBe(false);
    });

    it("returns false for browser TTS voice URIs", () => {
      // Browser voices have different URI formats
      expect(isEnhancedVoice("com.apple.speech.synthesis.voice.Alex")).toBe(false);
      expect(isEnhancedVoice("Google US English")).toBe(false);
      expect(isEnhancedVoice("Microsoft David Desktop")).toBe(false);
    });

    it("is case-sensitive", () => {
      expect(isEnhancedVoice("EN_US-LESSAC-MEDIUM")).toBe(false);
    });

    it("returns false for partial matches", () => {
      expect(isEnhancedVoice("en_US")).toBe(false);
      expect(isEnhancedVoice("lessac")).toBe(false);
    });
  });
});

describe("ENHANCED_VOICES constant", () => {
  it("contains at least one voice", () => {
    expect(ENHANCED_VOICES.length).toBeGreaterThan(0);
  });

  it("all voices have required properties", () => {
    for (const voice of ENHANCED_VOICES) {
      expect(voice.id).toBeDefined();
      expect(typeof voice.id).toBe("string");
      expect(voice.id.length).toBeGreaterThan(0);

      expect(voice.displayName).toBeDefined();
      expect(typeof voice.displayName).toBe("string");

      expect(voice.description).toBeDefined();
      expect(typeof voice.description).toBe("string");

      expect(voice.language).toMatch(/^[a-z]{2}-[A-Z]{2}$/);

      expect(["male", "female"]).toContain(voice.gender);
      expect(["low", "medium", "high"]).toContain(voice.quality);

      expect(voice.sizeBytes).toBeGreaterThan(0);
    }
  });

  it("all voice IDs are unique", () => {
    const ids = ENHANCED_VOICES.map((v) => v.id);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(ids.length);
  });

  it("contains expected US and UK voices", () => {
    const languages = ENHANCED_VOICES.map((v) => v.language);

    expect(languages).toContain("en-US");
    expect(languages).toContain("en-GB");
  });

  it("contains both male and female voices", () => {
    const genders = ENHANCED_VOICES.map((v) => v.gender);

    expect(genders).toContain("male");
    expect(genders).toContain("female");
  });
});
