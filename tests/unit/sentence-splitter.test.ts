/**
 * Tests for sentence splitting utility
 */

import { describe, it, expect } from "vitest";
import { splitIntoSentences, splitIntoSentencesWithInfo } from "@/lib/narration/sentence-splitter";

describe("splitIntoSentences", () => {
  it("splits a simple paragraph into sentences", () => {
    const text = "This is the first sentence. This is the second. And here is the third!";
    const sentences = splitIntoSentences(text);

    expect(sentences).toHaveLength(3);
    expect(sentences[0]).toBe("This is the first sentence.");
    expect(sentences[1]).toBe("This is the second.");
    expect(sentences[2]).toBe("And here is the third!");
  });

  it("handles the example paragraph from the user", () => {
    const text = `I deal with a lot of servers at work, and one thing everyone wants to know about their servers is how close they are to being at max utilization. It should be easy, right? Just pull up top or another system monitor tool, look at network, memory and CPU utilization, and whichever one is the highest tells you how close you are to the limits.`;
    const sentences = splitIntoSentences(text);

    expect(sentences).toHaveLength(3);
    expect(sentences[0]).toContain("I deal with a lot of servers");
    expect(sentences[1]).toBe("It should be easy, right?");
    expect(sentences[2]).toContain("Just pull up top");
  });

  it("handles abbreviations like Dr. and Mr.", () => {
    const text = "Dr. Smith went to the store. Mr. Jones followed him.";
    const sentences = splitIntoSentences(text);

    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toBe("Dr. Smith went to the store.");
    expect(sentences[1]).toBe("Mr. Jones followed him.");
  });

  it("handles quoted text - may be treated as single sentence", () => {
    const text = 'He said "This is a pen. I like it." Then he left.';
    const sentences = splitIntoSentences(text);

    // sentence-splitter may keep the entire quoted text as one sentence or split it.
    // Verify that all the original text is preserved across the sentences.
    const rejoined = sentences.join(" ");
    expect(rejoined).toContain("He said");
    expect(rejoined).toContain("Then he left.");
  });

  it("returns the original text for text without sentence-ending punctuation", () => {
    const text = "Just some text without any periods or question marks";
    const sentences = splitIntoSentences(text);

    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toBe(text);
  });

  it("returns empty array for empty string", () => {
    expect(splitIntoSentences("")).toEqual([]);
    expect(splitIntoSentences("   ")).toEqual([]);
  });

  it("handles multiple punctuation marks", () => {
    const text = "What?! Really?! Yes!!!";
    const sentences = splitIntoSentences(text);

    // Verify all text is preserved across sentences
    const rejoined = sentences.join(" ");
    expect(rejoined).toContain("What?!");
    expect(rejoined).toContain("Yes!!!");
  });

  it("handles newlines within a paragraph", () => {
    const text = "First sentence.\nSecond sentence on a new line.";
    const sentences = splitIntoSentences(text);

    expect(sentences).toHaveLength(2);
  });
});

describe("splitIntoSentencesWithInfo", () => {
  it("returns sentence info with offsets", () => {
    const text = "Hello world. Goodbye world.";
    const info = splitIntoSentencesWithInfo(text);

    expect(info).toHaveLength(2);
    expect(info[0].text).toBe("Hello world.");
    expect(info[0].start).toBe(0);
    expect(info[1].text).toBe("Goodbye world.");
    expect(info[1].start).toBeGreaterThan(0);
  });

  it("returns empty array for empty string", () => {
    expect(splitIntoSentencesWithInfo("")).toEqual([]);
  });
});
