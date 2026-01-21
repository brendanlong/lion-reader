/**
 * Unit tests for sentence splitter utilities.
 *
 * Tests splitIntoSentences and splitIntoSentencesWithInfo functions.
 */

import { describe, it, expect } from "vitest";
import { splitIntoSentences, splitIntoSentencesWithInfo } from "@/lib/narration/sentence-splitter";

describe("splitIntoSentences", () => {
  describe("basic sentence splitting", () => {
    it("splits simple sentences by period", () => {
      const text = "First sentence. Second sentence. Third sentence.";
      const sentences = splitIntoSentences(text);

      expect(sentences).toHaveLength(3);
      expect(sentences[0]).toBe("First sentence.");
      expect(sentences[1]).toBe("Second sentence.");
      expect(sentences[2]).toBe("Third sentence.");
    });

    it("splits sentences by question mark", () => {
      const text = "Is this a question? Yes it is.";
      const sentences = splitIntoSentences(text);

      expect(sentences).toHaveLength(2);
      expect(sentences[0]).toBe("Is this a question?");
      expect(sentences[1]).toBe("Yes it is.");
    });

    it("splits sentences by exclamation mark", () => {
      const text = "What a day! I can't believe it.";
      const sentences = splitIntoSentences(text);

      expect(sentences).toHaveLength(2);
      expect(sentences[0]).toBe("What a day!");
      expect(sentences[1]).toBe("I can't believe it.");
    });
  });

  describe("abbreviations and edge cases", () => {
    it("handles common abbreviations like Dr., Mr., Mrs.", () => {
      const text = "Dr. Smith met Mrs. Johnson. They discussed the case.";
      const sentences = splitIntoSentences(text);

      expect(sentences).toHaveLength(2);
      expect(sentences[0]).toBe("Dr. Smith met Mrs. Johnson.");
      expect(sentences[1]).toBe("They discussed the case.");
    });

    it("handles U.S.A. and similar abbreviations", () => {
      const text = "The U.S.A. is large. It has many states.";
      const sentences = splitIntoSentences(text);

      expect(sentences).toHaveLength(2);
    });

    it("handles etc. abbreviation", () => {
      const text = "I need apples, oranges, etc. Please get them.";
      const sentences = splitIntoSentences(text);

      expect(sentences).toHaveLength(2);
    });
  });

  describe("quoted text", () => {
    it("keeps sentences with quoted text together", () => {
      // The sentence splitter treats quoted text as part of the containing sentence,
      // which is desirable for TTS - you don't want to split mid-quote
      const text = 'He said "Hello there." Then he left.';
      const sentences = splitIntoSentences(text);

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe('He said "Hello there." Then he left.');
    });

    it("keeps sentences with single-quoted text together", () => {
      const text = "She replied 'I don't know.' It was unclear.";
      const sentences = splitIntoSentences(text);

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe("She replied 'I don't know.' It was unclear.");
    });
  });

  describe("empty and whitespace input", () => {
    it("returns empty array for empty string", () => {
      expect(splitIntoSentences("")).toEqual([]);
    });

    it("returns empty array for whitespace-only string", () => {
      expect(splitIntoSentences("   ")).toEqual([]);
      expect(splitIntoSentences("\n\t")).toEqual([]);
    });

    it("returns empty array for null-like input", () => {
      expect(splitIntoSentences(null as unknown as string)).toEqual([]);
      expect(splitIntoSentences(undefined as unknown as string)).toEqual([]);
    });
  });

  describe("text without sentence-ending punctuation", () => {
    it("returns entire text as single sentence when no punctuation", () => {
      const text = "This text has no ending punctuation";
      const sentences = splitIntoSentences(text);

      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toBe("This text has no ending punctuation");
    });
  });

  describe("multiple punctuation", () => {
    it("handles ellipsis", () => {
      const text = "Wait... What happened? I don't know.";
      const sentences = splitIntoSentences(text);

      expect(sentences.length).toBeGreaterThanOrEqual(2);
    });

    it("handles multiple exclamation marks", () => {
      const text = "Wow!! That's amazing! Really.";
      const sentences = splitIntoSentences(text);

      expect(sentences.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("preserves original text", () => {
    it("preserves original whitespace within sentences", () => {
      const text = "First  sentence. Second   sentence.";
      const sentences = splitIntoSentences(text);

      // Sentences should be trimmed but internal spacing preserved
      expect(sentences[0]).toContain("First  sentence");
    });
  });
});

describe("splitIntoSentencesWithInfo", () => {
  describe("basic functionality", () => {
    it("returns sentence info objects with text", () => {
      const text = "First. Second.";
      const result = splitIntoSentencesWithInfo(text);

      expect(result).toHaveLength(2);
      expect(result[0].text).toBe("First.");
      expect(result[1].text).toBe("Second.");
    });

    it("includes start and end positions", () => {
      const text = "Hello. World.";
      const result = splitIntoSentencesWithInfo(text);

      expect(result[0].start).toBe(0);
      expect(result[0].end).toBeGreaterThan(0);
      expect(result[1].start).toBeGreaterThan(result[0].start);
    });

    it("positions allow extracting original text", () => {
      const text = "First sentence. Second sentence.";
      const result = splitIntoSentencesWithInfo(text);

      for (const info of result) {
        const extracted = text.slice(info.start, info.end).trim();
        expect(extracted).toBe(info.text);
      }
    });
  });

  describe("empty input", () => {
    it("returns empty array for empty string", () => {
      expect(splitIntoSentencesWithInfo("")).toEqual([]);
    });

    it("returns empty array for whitespace-only string", () => {
      expect(splitIntoSentencesWithInfo("   ")).toEqual([]);
    });
  });

  describe("text without punctuation", () => {
    it("returns single sentence info for unpunctuated text", () => {
      const text = "No punctuation here";
      const result = splitIntoSentencesWithInfo(text);

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe("No punctuation here");
      expect(result[0].start).toBe(0);
      expect(result[0].end).toBe(text.length);
    });
  });

  describe("info object structure", () => {
    it("each info object has text, start, and end properties", () => {
      const text = "Test sentence.";
      const result = splitIntoSentencesWithInfo(text);

      expect(result[0]).toHaveProperty("text");
      expect(result[0]).toHaveProperty("start");
      expect(result[0]).toHaveProperty("end");
      expect(typeof result[0].text).toBe("string");
      expect(typeof result[0].start).toBe("number");
      expect(typeof result[0].end).toBe("number");
    });

    it("end is always greater than or equal to start", () => {
      const text = "A. B. C. D.";
      const result = splitIntoSentencesWithInfo(text);

      for (const info of result) {
        expect(info.end).toBeGreaterThanOrEqual(info.start);
      }
    });

    it("sentences are in order of appearance", () => {
      const text = "First. Second. Third.";
      const result = splitIntoSentencesWithInfo(text);

      for (let i = 1; i < result.length; i++) {
        expect(result[i].start).toBeGreaterThan(result[i - 1].start);
      }
    });
  });
});
