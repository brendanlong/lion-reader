/**
 * Unit tests for voice ranking utilities.
 *
 * Tests the rankVoices function which sorts voices by quality heuristics.
 */

import { describe, it, expect } from "vitest";
import { rankVoices } from "@/lib/narration/voices";

/**
 * Creates a mock SpeechSynthesisVoice object for testing.
 */
function createMockVoice(
  name: string,
  options: Partial<{
    default: boolean;
    localService: boolean;
    lang: string;
    voiceURI: string;
  }> = {}
): SpeechSynthesisVoice {
  return {
    name,
    default: options.default ?? false,
    localService: options.localService ?? true,
    lang: options.lang ?? "en-US",
    voiceURI: options.voiceURI ?? name,
  };
}

describe("rankVoices", () => {
  describe("non-default preference", () => {
    it("ranks non-default voices above default voices", () => {
      const defaultVoice = createMockVoice("Default Voice", { default: true });
      const nonDefaultVoice = createMockVoice("Premium Voice", { default: false });

      const ranked = rankVoices([defaultVoice, nonDefaultVoice]);

      expect(ranked[0].name).toBe("Premium Voice");
      expect(ranked[1].name).toBe("Default Voice");
    });
  });

  describe("local vs remote preference", () => {
    it("ranks local voices above remote voices", () => {
      const remoteVoice = createMockVoice("Cloud Voice", { localService: false });
      const localVoice = createMockVoice("Local Voice", { localService: true });

      const ranked = rankVoices([remoteVoice, localVoice]);

      expect(ranked[0].name).toBe("Local Voice");
      expect(ranked[1].name).toBe("Cloud Voice");
    });
  });

  describe("combined preference rules", () => {
    it("prioritizes non-default over local service", () => {
      // Non-default takes priority, even if it's remote
      const defaultLocal = createMockVoice("Default Local", {
        default: true,
        localService: true,
      });
      const nonDefaultRemote = createMockVoice("Premium Remote", {
        default: false,
        localService: false,
      });

      const ranked = rankVoices([defaultLocal, nonDefaultRemote]);

      // Non-default wins over default, even though it's remote
      expect(ranked[0].name).toBe("Premium Remote");
    });
  });

  describe("alphabetical fallback", () => {
    it("sorts alphabetically when other criteria are equal", () => {
      const voiceC = createMockVoice("Charlie");
      const voiceA = createMockVoice("Alpha");
      const voiceB = createMockVoice("Bravo");

      const ranked = rankVoices([voiceC, voiceA, voiceB]);

      expect(ranked.map((v) => v.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
    });
  });

  describe("edge cases", () => {
    it("returns empty array for empty input", () => {
      expect(rankVoices([])).toEqual([]);
    });

    it("does not mutate the original array", () => {
      const original = [createMockVoice("Zulu"), createMockVoice("Alpha")];
      const originalOrder = original.map((v) => v.name);

      rankVoices(original);

      expect(original.map((v) => v.name)).toEqual(originalOrder);
    });
  });

  describe("realistic voice ranking", () => {
    it("ranks a realistic set of browser voices correctly", () => {
      const voices = [
        createMockVoice("Google US English", {
          default: true,
          localService: false,
        }),
        createMockVoice("Alex", {
          default: false,
          localService: true,
        }),
        createMockVoice("Samantha", {
          default: false,
          localService: true,
        }),
        createMockVoice("Microsoft David", {
          default: false,
          localService: false,
        }),
      ];

      const ranked = rankVoices(voices);

      // Non-default local voices should be first (Alex, Samantha alphabetically)
      expect(ranked[0].name).toBe("Alex");
      expect(ranked[1].name).toBe("Samantha");
      // Non-default remote next
      expect(ranked[2].name).toBe("Microsoft David");
      // Default last
      expect(ranked[3].name).toBe("Google US English");
    });
  });
});
