/**
 * Unit tests for sentence splitter utilities.
 *
 * Tests splitIntoSentences and splitLongSentence.
 */

import { describe, it, expect } from "vitest";
import {
  splitIntoSentences,
  splitLongSentence,
  MAX_CHUNK_CHARS,
} from "@/lib/narration/sentence-splitter";

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

describe("long sentence chunking", () => {
  // A real single-sentence paragraph that sounded rushed under Piper TTS
  // (395 chars, comma-separated clauses) — see the "In this post I will show…"
  // paragraph in the fork-around-and-find-out-part-2 post.
  const LONG_SENTENCE =
    "In this post I will show that controls rule out obvious alternative readings about block 5, that knight forks are mostly assembled compositionally (check plus queen attack) rather than holistically, and give causal evidence via ablations that tie the fork’s decodability to one specific attention head, ending on one potential confound that threatens to completely reshape what our results mean.";

  it("leaves sentences within the limit unchanged", () => {
    const short = "This is a perfectly reasonable length sentence.";
    expect(short.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(splitLongSentence(short)).toEqual([short]);
  });

  it("splits an over-long sentence into multiple chunks under the limit", () => {
    const chunks = splitLongSentence(LONG_SENTENCE);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  it("splits at clause boundaries, preserving all words in order", () => {
    const chunks = splitLongSentence(LONG_SENTENCE);

    // Every word from the original survives, in order, when rejoined.
    const originalWords = LONG_SENTENCE.split(/\s+/);
    const chunkedWords = chunks.join(" ").split(/\s+/);
    expect(chunkedWords).toEqual(originalWords);
  });

  it("splits a very long run-on clause at word boundaries", () => {
    // No clause punctuation at all, so it can only break on words.
    const runOn = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    expect(runOn.length).toBeGreaterThan(MAX_CHUNK_CHARS);

    const chunks = splitLongSentence(runOn);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
    expect(chunks.join(" ")).toBe(runOn);
  });

  it("applies chunking through splitIntoSentences", () => {
    const chunks = splitIntoSentences(LONG_SENTENCE);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });
});
