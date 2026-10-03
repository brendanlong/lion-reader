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
      for (const expected of ENHANCED_VOICES) {
        expect(findEnhancedVoice(expected.id)).toBe(expected);
      }
    });
  });

  describe("non-existent voices", () => {
    it("returns undefined for unknown voice IDs", () => {
      expect(findEnhancedVoice("nonexistent-voice")).toBeUndefined();
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

    it("returns false for browser TTS voice URIs", () => {
      // Browser voices have different URI formats
      expect(isEnhancedVoice("com.apple.speech.synthesis.voice.Alex")).toBe(false);
      expect(isEnhancedVoice("Google US English")).toBe(false);
      expect(isEnhancedVoice("Microsoft David Desktop")).toBe(false);
    });
  });
});

describe("ENHANCED_VOICES constant", () => {
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
});
