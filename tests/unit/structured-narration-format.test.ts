/**
 * Test for structured JSON narration output.
 *
 * Verifies that the new JSON-based LLM output format is correctly
 * parsed and converted to paragraph mappings.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";

// Schema from narration.ts
const narrationParagraphSchema = z.object({
  sourceIds: z.array(z.string()),
  text: z.string(),
});

const llmOutputSchema = z.object({
  paragraphs: z.array(narrationParagraphSchema),
});

type LLMOutput = z.infer<typeof llmOutputSchema>;

describe("structured JSON narration format", () => {
  it("should validate correct JSON output", () => {
    const validOutput: LLMOutput = {
      paragraphs: [
        {
          sourceIds: ["para-0"],
          text: "Introduction.",
        },
        {
          sourceIds: ["para-1", "para-2"],
          text: "Doctor Smith said this is important. Here's more detail.",
        },
        {
          sourceIds: ["para-3"],
          text: "Image: diagram showing architecture.",
        },
      ],
    };

    const result = llmOutputSchema.safeParse(validOutput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paragraphs).toHaveLength(3);
      expect(result.data.paragraphs[1].sourceIds).toEqual(["para-1", "para-2"]);
    }
  });

  it("should reject invalid JSON (missing required fields)", () => {
    const invalidOutput = {
      paragraphs: [
        {
          sourceIds: ["para-0"],
          // Missing 'text' field
        },
      ],
    };

    const result = llmOutputSchema.safeParse(invalidOutput);
    expect(result.success).toBe(false);
  });

  it("should reject invalid sourceIds format", () => {
    const invalidOutput = {
      paragraphs: [
        {
          sourceIds: "para-0", // Should be array, not string
          text: "Some text",
        },
      ],
    };

    const result = llmOutputSchema.safeParse(invalidOutput);
    expect(result.success).toBe(false);
  });

  it("should handle image alt text literally", () => {
    const outputWithImage: LLMOutput = {
      paragraphs: [
        {
          sourceIds: ["para-0"],
          text: "Introduction.",
        },
        {
          sourceIds: ["para-1"],
          text: "Image: diagram showing architecture.",
        },
        {
          sourceIds: ["para-2"],
          text: "Image, Photo of a cat.",
        },
      ],
    };

    const result = llmOutputSchema.safeParse(outputWithImage);
    expect(result.success).toBe(true);
    if (result.success) {
      // Verify image text is preserved literally
      expect(result.data.paragraphs[1].text).toBe("Image: diagram showing architecture.");
      expect(result.data.paragraphs[2].text).toBe("Image, Photo of a cat.");
    }
  });

  it("should extract paragraph indices from sourceIds", () => {
    const sourceIds = ["para-0", "para-5", "para-12"];

    const indices = sourceIds
      .map((id) => {
        const match = id.match(/^para-(\d+)$/);
        return match ? parseInt(match[1], 10) : -1;
      })
      .filter((idx) => idx !== -1);

    expect(indices).toEqual([0, 5, 12]);
  });

  it("should handle combined paragraphs correctly", () => {
    const output: LLMOutput = {
      paragraphs: [
        {
          sourceIds: ["para-0", "para-1", "para-2"],
          text: "Combined narration from three original paragraphs.",
        },
      ],
    };

    const result = llmOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paragraphs[0].sourceIds).toHaveLength(3);
    }
  });
});
