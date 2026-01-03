/**
 * Test for structured JSON narration output.
 *
 * Verifies that the JSON-based LLM output format is correctly
 * parsed with the forgiving schema (id as string or number, text nullable).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";

// Schema from narration.ts - forgiving of id as string or number
const llmParagraphSchema = z.object({
  id: z
    .union([z.number(), z.string()])
    .transform((val) => (typeof val === "string" ? parseInt(val, 10) : val)),
  text: z
    .string()
    .nullable()
    .transform((val) => val ?? ""),
});

const llmOutputSchema = z.object({
  paragraphs: z.array(llmParagraphSchema),
});

describe("structured JSON narration format", () => {
  it("should validate correct JSON output with numeric ids", () => {
    const validOutput = {
      paragraphs: [
        { id: 0, text: "Introduction." },
        { id: 1, text: "Doctor Smith said this is important." },
        { id: 2, text: "Image: diagram showing architecture." },
      ],
    };

    const result = llmOutputSchema.safeParse(validOutput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paragraphs).toHaveLength(3);
      expect(result.data.paragraphs[0].id).toBe(0);
      expect(result.data.paragraphs[1].id).toBe(1);
    }
  });

  it("should accept string ids and convert to numbers", () => {
    const outputWithStringIds = {
      paragraphs: [
        { id: "0", text: "First paragraph." },
        { id: "1", text: "Second paragraph." },
      ],
    };

    const result = llmOutputSchema.safeParse(outputWithStringIds);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paragraphs[0].id).toBe(0);
      expect(result.data.paragraphs[1].id).toBe(1);
    }
  });

  it("should reject invalid JSON (missing required fields)", () => {
    const invalidOutput = {
      paragraphs: [
        {
          id: 0,
          // Missing 'text' field
        },
      ],
    };

    const result = llmOutputSchema.safeParse(invalidOutput);
    expect(result.success).toBe(false);
  });

  it("should accept null text and convert to empty string", () => {
    const outputWithNullText = {
      paragraphs: [
        { id: 0, text: "First paragraph." },
        { id: 1, text: null }, // Intentionally skip this paragraph
        { id: 2, text: "Third paragraph." },
      ],
    };

    const result = llmOutputSchema.safeParse(outputWithNullText);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paragraphs[1].text).toBe("");
    }
  });

  it("should accept empty string text for skipped paragraphs", () => {
    const outputWithEmptyText = {
      paragraphs: [
        { id: 0, text: "First paragraph." },
        { id: 1, text: "" }, // Garbage paragraph marked for skip
        { id: 2, text: "Third paragraph." },
      ],
    };

    const result = llmOutputSchema.safeParse(outputWithEmptyText);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paragraphs[1].text).toBe("");
    }
  });

  it("should handle image alt text", () => {
    const outputWithImage = {
      paragraphs: [
        { id: 0, text: "Introduction." },
        { id: 1, text: "Image: diagram showing architecture." },
        { id: 2, text: "Image, Photo of a cat." },
      ],
    };

    const result = llmOutputSchema.safeParse(outputWithImage);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paragraphs[1].text).toBe("Image: diagram showing architecture.");
      expect(result.data.paragraphs[2].text).toBe("Image, Photo of a cat.");
    }
  });

  it("should reject non-object paragraphs", () => {
    const invalidOutput = {
      paragraphs: ["just a string", "another string"],
    };

    const result = llmOutputSchema.safeParse(invalidOutput);
    expect(result.success).toBe(false);
  });

  it("should reject missing paragraphs array", () => {
    const invalidOutput = {
      text: "Some text without paragraphs array",
    };

    const result = llmOutputSchema.safeParse(invalidOutput);
    expect(result.success).toBe(false);
  });
});
