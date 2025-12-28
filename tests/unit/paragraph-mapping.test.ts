/**
 * Unit tests for paragraph mapping parser.
 */

import { describe, it, expect } from "vitest";
import {
  parseNarrationOutput,
  createPositionalMapping,
  stripMarkers,
  hasParaMarkers,
} from "../../src/lib/narration/paragraph-mapping";

describe("parseNarrationOutput", () => {
  describe("basic single markers", () => {
    it("parses a single paragraph with one marker", () => {
      const output = "[PARA:0]First paragraph with Doctor Smith.";
      const paragraphOrder = ["para-0"];

      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual(["First paragraph with Doctor Smith."]);
      expect(result.mapping).toEqual([{ narrationIndex: 0, originalIndices: [0] }]);
    });

    it("parses multiple paragraphs with sequential markers", () => {
      const output = `[PARA:0]First paragraph with Doctor Smith.

[PARA:1]Second paragraph.

[PARA:2]Third paragraph.`;

      const paragraphOrder = ["para-0", "para-1", "para-2"];
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual([
        "First paragraph with Doctor Smith.",
        "Second paragraph.",
        "Third paragraph.",
      ]);
      expect(result.mapping).toEqual([
        { narrationIndex: 0, originalIndices: [0] },
        { narrationIndex: 1, originalIndices: [1] },
        { narrationIndex: 2, originalIndices: [2] },
      ]);
    });

    it("handles markers not at the start of paragraph", () => {
      const output = `Introduction: [PARA:0]First paragraph.

And then: [PARA:1]Second paragraph.`;

      const paragraphOrder = ["para-0", "para-1"];
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual([
        "Introduction: First paragraph.",
        "And then: Second paragraph.",
      ]);
      expect(result.mapping).toEqual([
        { narrationIndex: 0, originalIndices: [0] },
        { narrationIndex: 1, originalIndices: [1] },
      ]);
    });

    it("handles non-sequential markers", () => {
      const output = `[PARA:0]First paragraph.

[PARA:2]Third paragraph (second was skipped).

[PARA:5]Sixth paragraph.`;

      const paragraphOrder = ["para-0", "para-1", "para-2", "para-3", "para-4", "para-5"];
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual([
        "First paragraph.",
        "Third paragraph (second was skipped).",
        "Sixth paragraph.",
      ]);
      expect(result.mapping).toEqual([
        { narrationIndex: 0, originalIndices: [0] },
        { narrationIndex: 1, originalIndices: [2] },
        { narrationIndex: 2, originalIndices: [5] },
      ]);
    });
  });

  describe("multiple markers per paragraph (combined content)", () => {
    it("parses paragraph with two consecutive markers", () => {
      const output = `[PARA:0]First paragraph.

[PARA:1][PARA:2]Combined second and third paragraphs.

[PARA:3]Fourth paragraph.`;

      const paragraphOrder = ["para-0", "para-1", "para-2", "para-3"];
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual([
        "First paragraph.",
        "Combined second and third paragraphs.",
        "Fourth paragraph.",
      ]);
      expect(result.mapping).toEqual([
        { narrationIndex: 0, originalIndices: [0] },
        { narrationIndex: 1, originalIndices: [1, 2] },
        { narrationIndex: 2, originalIndices: [3] },
      ]);
    });

    it("parses paragraph with three consecutive markers", () => {
      const output = "[PARA:0][PARA:1][PARA:2]All three combined.";
      const paragraphOrder = ["para-0", "para-1", "para-2"];

      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual(["All three combined."]);
      expect(result.mapping).toEqual([{ narrationIndex: 0, originalIndices: [0, 1, 2] }]);
    });

    it("handles non-consecutive markers being combined", () => {
      const output = "[PARA:1][PARA:3][PARA:5]Every other paragraph combined.";
      const paragraphOrder = ["para-0", "para-1", "para-2", "para-3", "para-4", "para-5"];

      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual(["Every other paragraph combined."]);
      expect(result.mapping).toEqual([{ narrationIndex: 0, originalIndices: [1, 3, 5] }]);
    });

    it("handles markers with space between them", () => {
      const output = "[PARA:0] [PARA:1] Combined with spaces.";
      const paragraphOrder = ["para-0", "para-1"];

      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual(["Combined with spaces."]);
      expect(result.mapping).toEqual([{ narrationIndex: 0, originalIndices: [0, 1] }]);
    });

    it("sorts original indices in ascending order", () => {
      const output = "[PARA:3][PARA:1][PARA:2]Out of order markers.";
      const paragraphOrder = ["para-0", "para-1", "para-2", "para-3"];

      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.mapping[0].originalIndices).toEqual([1, 2, 3]);
    });

    it("deduplicates repeated markers", () => {
      const output = "[PARA:0][PARA:0][PARA:1][PARA:1]Repeated markers.";
      const paragraphOrder = ["para-0", "para-1"];

      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.mapping[0].originalIndices).toEqual([0, 1]);
    });
  });

  describe("missing markers (fallback to positional)", () => {
    it("uses positional mapping when no markers present", () => {
      const output = `First paragraph.

Second paragraph.

Third paragraph.`;

      const paragraphOrder = ["para-0", "para-1", "para-2"];
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual([
        "First paragraph.",
        "Second paragraph.",
        "Third paragraph.",
      ]);
      expect(result.mapping).toEqual([
        { narrationIndex: 0, originalIndices: [0] },
        { narrationIndex: 1, originalIndices: [1] },
        { narrationIndex: 2, originalIndices: [2] },
      ]);
    });

    it("caps positional mapping at last original index", () => {
      const output = `First paragraph.

Second paragraph.

Third paragraph.

Fourth paragraph.

Fifth paragraph.`;

      const paragraphOrder = ["para-0", "para-1", "para-2"]; // Only 3 originals
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toHaveLength(5);
      expect(result.mapping).toEqual([
        { narrationIndex: 0, originalIndices: [0] },
        { narrationIndex: 1, originalIndices: [1] },
        { narrationIndex: 2, originalIndices: [2] },
        { narrationIndex: 3, originalIndices: [2] }, // Capped
        { narrationIndex: 4, originalIndices: [2] }, // Capped
      ]);
    });

    it("handles single paragraph without markers", () => {
      const output = "Just one paragraph.";
      const paragraphOrder = ["para-0"];

      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual(["Just one paragraph."]);
      expect(result.mapping).toEqual([{ narrationIndex: 0, originalIndices: [0] }]);
    });
  });

  describe("empty paragraphs", () => {
    it("filters out empty paragraphs after marker removal", () => {
      const output = `[PARA:0]First paragraph.

[PARA:1]

[PARA:2]Third paragraph.`;

      const paragraphOrder = ["para-0", "para-1", "para-2"];
      const result = parseNarrationOutput(output, paragraphOrder);

      // Empty paragraph after marker removal is filtered out
      expect(result.narrationParagraphs).toEqual(["First paragraph.", "Third paragraph."]);
      expect(result.mapping).toEqual([
        { narrationIndex: 0, originalIndices: [0] },
        { narrationIndex: 1, originalIndices: [2] },
      ]);
    });

    it("handles paragraph with only markers (no text)", () => {
      const output = `[PARA:0]Real content.

[PARA:1][PARA:2]

[PARA:3]More content.`;

      const paragraphOrder = ["para-0", "para-1", "para-2", "para-3"];
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual(["Real content.", "More content."]);
    });

    it("handles empty input", () => {
      const result = parseNarrationOutput("", ["para-0"]);

      expect(result.narrationParagraphs).toEqual([]);
      expect(result.mapping).toEqual([]);
    });

    it("handles whitespace-only input", () => {
      const result = parseNarrationOutput("   \n\n\t  ", ["para-0"]);

      expect(result.narrationParagraphs).toEqual([]);
      expect(result.mapping).toEqual([]);
    });
  });

  describe("various whitespace patterns", () => {
    it("handles multiple newlines between paragraphs", () => {
      const output = `[PARA:0]First.



[PARA:1]Second.`;

      const paragraphOrder = ["para-0", "para-1"];
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual(["First.", "Second."]);
    });

    it("handles tabs and mixed whitespace", () => {
      const output = `[PARA:0]First paragraph.

\t[PARA:1]Second paragraph with tab.

   [PARA:2]Third with spaces.`;

      const paragraphOrder = ["para-0", "para-1", "para-2"];
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual([
        "First paragraph.",
        "Second paragraph with tab.",
        "Third with spaces.",
      ]);
    });

    it("trims whitespace from paragraph content", () => {
      const output = `[PARA:0]   Content with leading spaces.

[PARA:1]   More content.`;

      const paragraphOrder = ["para-0", "para-1"];
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual(["Content with leading spaces.", "More content."]);
    });

    it("preserves internal whitespace", () => {
      const output = "[PARA:0]Content  with   multiple   spaces.";
      const paragraphOrder = ["para-0"];

      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual(["Content  with   multiple   spaces."]);
    });

    it("handles Windows-style line endings", () => {
      const output = "[PARA:0]First.\r\n\r\n[PARA:1]Second.";
      const paragraphOrder = ["para-0", "para-1"];

      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual(["First.", "Second."]);
    });
  });

  describe("special content", () => {
    it("handles code block narration", () => {
      const output = `[PARA:0]Introduction.

[PARA:1]Code block: npm install lodash. End code block.

[PARA:2]Conclusion.`;

      const paragraphOrder = ["para-0", "para-1", "para-2"];
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs[1]).toBe("Code block: npm install lodash. End code block.");
    });

    it("handles text with special characters", () => {
      const output = `[PARA:0]Doctor Smith said "Hello" & 'Goodbye'.

[PARA:1]Math: 2 < 3 > 1.`;

      const paragraphOrder = ["para-0", "para-1"];
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual([
        `Doctor Smith said "Hello" & 'Goodbye'.`,
        "Math: 2 < 3 > 1.",
      ]);
    });

    it("handles text with colons (should not confuse with markers)", () => {
      const output = `[PARA:0]Time is: 12:30:45.

[PARA:1]URL: https://example.com`;

      const paragraphOrder = ["para-0", "para-1"];
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual([
        "Time is: 12:30:45.",
        "URL: https://example.com",
      ]);
    });

    it("handles text with brackets that are not markers", () => {
      const output = `[PARA:0]Array syntax: [1, 2, 3].

[PARA:1]Object: { key: "value" }.`;

      const paragraphOrder = ["para-0", "para-1"];
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual([
        "Array syntax: [1, 2, 3].",
        'Object: { key: "value" }.',
      ]);
    });

    it("does not match malformed markers", () => {
      const output = `[PARA:]No number.

[PARA:abc]Non-numeric.

[PARA: 0]Space before number.

[PARA:0]Valid marker.`;

      const paragraphOrder = ["para-0"];
      const result = parseNarrationOutput(output, paragraphOrder);

      // Only the valid marker should be processed
      expect(result.narrationParagraphs).toContain("Valid marker.");
      expect(result.narrationParagraphs).toContain("[PARA:]No number.");
      expect(result.narrationParagraphs).toContain("[PARA:abc]Non-numeric.");
      expect(result.narrationParagraphs).toContain("[PARA: 0]Space before number.");
    });
  });

  describe("edge cases", () => {
    it("handles large paragraph indices", () => {
      const output = "[PARA:999]Large index paragraph.";
      const paragraphOrder = Array.from({ length: 1000 }, (_, i) => `para-${i}`);

      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.mapping).toEqual([{ narrationIndex: 0, originalIndices: [999] }]);
    });

    it("handles empty paragraphOrder array", () => {
      const output = "[PARA:0]Content.";
      const paragraphOrder: string[] = [];

      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual(["Content."]);
      // Should still map to index 0
      expect(result.mapping).toEqual([{ narrationIndex: 0, originalIndices: [0] }]);
    });

    it("handles paragraph with marker in the middle", () => {
      const output = "Start [PARA:0] middle [PARA:1] end.";
      const paragraphOrder = ["para-0", "para-1"];

      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual(["Start  middle  end."]);
      expect(result.mapping).toEqual([{ narrationIndex: 0, originalIndices: [0, 1] }]);
    });

    it("handles very long paragraph text", () => {
      const longText = "A".repeat(10000);
      const output = `[PARA:0]${longText}`;
      const paragraphOrder = ["para-0"];

      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs[0]).toBe(longText);
    });

    it("handles paragraph with only whitespace after markers", () => {
      const output = "[PARA:0]   ";
      const paragraphOrder = ["para-0"];

      const result = parseNarrationOutput(output, paragraphOrder);

      // Should be filtered out as empty
      expect(result.narrationParagraphs).toEqual([]);
      expect(result.mapping).toEqual([]);
    });

    it("handles mixed paragraphs - some with markers, some without", () => {
      // When some paragraphs have markers, we use markers for all
      // But paragraphs without markers get fallback mapping
      const output = `[PARA:0]First has marker.

Second has no marker.

[PARA:2]Third has marker.`;

      const paragraphOrder = ["para-0", "para-1", "para-2"];
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toEqual([
        "First has marker.",
        "Second has no marker.",
        "Third has marker.",
      ]);
      expect(result.mapping[0].originalIndices).toEqual([0]);
      expect(result.mapping[1].originalIndices).toEqual([1]); // Fallback to narration index
      expect(result.mapping[2].originalIndices).toEqual([2]);
    });
  });

  describe("realistic LLM output", () => {
    it("parses typical article narration", () => {
      const output = `[PARA:0]Introduction.

[PARA:1]Doctor Smith said this is important.

[PARA:2]Code block: npm install lodash. End code block.

[PARA:3]As shown in the image above, the dashboard displays key metrics.

[PARA:4]In conclusion, always remember to test your code.`;

      const paragraphOrder = ["para-0", "para-1", "para-2", "para-3", "para-4"];
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toHaveLength(5);
      expect(result.mapping).toHaveLength(5);

      result.mapping.forEach((m, i) => {
        expect(m.narrationIndex).toBe(i);
        expect(m.originalIndices).toEqual([i]);
      });
    });

    it("handles LLM combining short paragraphs", () => {
      const output = `[PARA:0]Welcome to our guide.

[PARA:1][PARA:2]This section covers the basics. It builds on the previous introduction.

[PARA:3]Here is an example.

[PARA:4][PARA:5][PARA:6]The next few points summarize the key takeaways. First point. Second point. Third point.

[PARA:7]Goodbye.`;

      const paragraphOrder = [
        "para-0",
        "para-1",
        "para-2",
        "para-3",
        "para-4",
        "para-5",
        "para-6",
        "para-7",
      ];
      const result = parseNarrationOutput(output, paragraphOrder);

      expect(result.narrationParagraphs).toHaveLength(5);
      expect(result.mapping).toEqual([
        { narrationIndex: 0, originalIndices: [0] },
        { narrationIndex: 1, originalIndices: [1, 2] },
        { narrationIndex: 2, originalIndices: [3] },
        { narrationIndex: 3, originalIndices: [4, 5, 6] },
        { narrationIndex: 4, originalIndices: [7] },
      ]);
    });
  });
});

describe("createPositionalMapping", () => {
  describe("basic cases", () => {
    it("creates 1:1 mapping when counts are equal", () => {
      const result = createPositionalMapping(3, 3);

      expect(result).toEqual([
        { narrationIndex: 0, originalIndices: [0] },
        { narrationIndex: 1, originalIndices: [1] },
        { narrationIndex: 2, originalIndices: [2] },
      ]);
    });

    it("creates mapping when narration has fewer paragraphs", () => {
      const result = createPositionalMapping(2, 5);

      expect(result).toEqual([
        { narrationIndex: 0, originalIndices: [0] },
        { narrationIndex: 1, originalIndices: [1] },
      ]);
    });

    it("caps at last original index when narration has more paragraphs", () => {
      const result = createPositionalMapping(5, 3);

      expect(result).toEqual([
        { narrationIndex: 0, originalIndices: [0] },
        { narrationIndex: 1, originalIndices: [1] },
        { narrationIndex: 2, originalIndices: [2] },
        { narrationIndex: 3, originalIndices: [2] },
        { narrationIndex: 4, originalIndices: [2] },
      ]);
    });
  });

  describe("edge cases", () => {
    it("returns empty array for zero narration paragraphs", () => {
      const result = createPositionalMapping(0, 5);

      expect(result).toEqual([]);
    });

    it("returns empty array for negative narration count", () => {
      const result = createPositionalMapping(-1, 5);

      expect(result).toEqual([]);
    });

    it("maps all to index 0 when original count is zero", () => {
      const result = createPositionalMapping(3, 0);

      expect(result).toEqual([
        { narrationIndex: 0, originalIndices: [0] },
        { narrationIndex: 1, originalIndices: [0] },
        { narrationIndex: 2, originalIndices: [0] },
      ]);
    });

    it("maps all to index 0 when original count is negative", () => {
      const result = createPositionalMapping(2, -1);

      expect(result).toEqual([
        { narrationIndex: 0, originalIndices: [0] },
        { narrationIndex: 1, originalIndices: [0] },
      ]);
    });

    it("handles single paragraph", () => {
      const result = createPositionalMapping(1, 1);

      expect(result).toEqual([{ narrationIndex: 0, originalIndices: [0] }]);
    });

    it("handles large counts", () => {
      const result = createPositionalMapping(100, 100);

      expect(result).toHaveLength(100);
      expect(result[0]).toEqual({ narrationIndex: 0, originalIndices: [0] });
      expect(result[99]).toEqual({ narrationIndex: 99, originalIndices: [99] });
    });
  });
});

describe("stripMarkers", () => {
  it("removes single marker", () => {
    expect(stripMarkers("[PARA:0]Hello world")).toBe("Hello world");
  });

  it("removes multiple markers", () => {
    expect(stripMarkers("[PARA:0][PARA:1]Hello world")).toBe("Hello world");
  });

  it("removes markers from middle of text", () => {
    expect(stripMarkers("Hello [PARA:0] world [PARA:1] test")).toBe("Hello  world  test");
  });

  it("handles text with no markers", () => {
    expect(stripMarkers("Hello world")).toBe("Hello world");
  });

  it("handles empty string", () => {
    expect(stripMarkers("")).toBe("");
  });

  it("handles string with only markers", () => {
    expect(stripMarkers("[PARA:0][PARA:1]")).toBe("");
  });

  it("trims resulting text", () => {
    expect(stripMarkers("  [PARA:0]Hello  ")).toBe("Hello");
  });
});

describe("hasParaMarkers", () => {
  it("returns true for text with single marker", () => {
    expect(hasParaMarkers("[PARA:0]Hello")).toBe(true);
  });

  it("returns true for text with multiple markers", () => {
    expect(hasParaMarkers("[PARA:0][PARA:1]Hello")).toBe(true);
  });

  it("returns true for text with marker in middle", () => {
    expect(hasParaMarkers("Hello [PARA:5] world")).toBe(true);
  });

  it("returns true for large index", () => {
    expect(hasParaMarkers("[PARA:999]Hello")).toBe(true);
  });

  it("returns false for text without markers", () => {
    expect(hasParaMarkers("Hello world")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasParaMarkers("")).toBe(false);
  });

  it("returns false for malformed markers", () => {
    expect(hasParaMarkers("[PARA:]Hello")).toBe(false);
    expect(hasParaMarkers("[PARA:abc]Hello")).toBe(false);
    expect(hasParaMarkers("[PARA: 0]Hello")).toBe(false);
    expect(hasParaMarkers("PARA:0]Hello")).toBe(false);
    expect(hasParaMarkers("[PARA:0Hello")).toBe(false);
  });

  it("returns false for similar but invalid patterns", () => {
    expect(hasParaMarkers("[PARA:]")).toBe(false);
    expect(hasParaMarkers("[para:0]")).toBe(false); // Case sensitive
    expect(hasParaMarkers("[[PARA:0]]")).toBe(true); // Contains valid marker
  });
});
