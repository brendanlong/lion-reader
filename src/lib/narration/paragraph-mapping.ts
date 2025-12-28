/**
 * Paragraph Mapping Parser for Narration Highlighting
 *
 * This module provides utilities to parse LLM output and extract paragraph
 * mappings for synchronizing narration playback with original HTML content.
 *
 * @module narration/paragraph-mapping
 */

/**
 * Mapping from a single narration paragraph to its original paragraph(s).
 */
export interface NarrationToOriginal {
  /** Index of the narration paragraph (0-based) */
  narrationIndex: number;
  /** Indices of the original paragraph(s) this maps to */
  originalIndices: number[];
}

/**
 * Result of parsing narration output, containing cleaned text and mapping.
 */
export interface ParagraphMapping {
  /** Narration text split by paragraph (markers removed) */
  narrationParagraphs: string[];
  /** Mapping from narration index to original paragraph indices */
  mapping: NarrationToOriginal[];
}

/**
 * Regex pattern to match [PARA:X] markers in LLM output.
 * Matches patterns like [PARA:0], [PARA:12], etc.
 */
const PARA_MARKER_REGEX = /\[PARA:(\d+)\]/g;

/**
 * Parses LLM narration output to extract paragraph mapping.
 *
 * The LLM output contains `[PARA:X]` markers indicating which original
 * paragraph(s) each narration paragraph corresponds to. This function:
 * 1. Splits the output into paragraphs (by double newline)
 * 2. Extracts all `[PARA:X]` markers from each paragraph
 * 3. Removes markers from the final text
 * 4. Builds the mapping array
 * 5. Falls back to positional mapping if no markers found
 *
 * @param llmOutput - The raw LLM output containing `[PARA:X]` markers
 * @param paragraphOrder - Array of paragraph IDs in original document order
 * @returns Object containing cleaned narration paragraphs and mapping
 *
 * @example
 * const output = `[PARA:0]First paragraph with Doctor Smith.
 *
 * [PARA:1]Second paragraph.
 *
 * [PARA:2][PARA:3]Combined paragraphs.`;
 *
 * const result = parseNarrationOutput(output, ['para-0', 'para-1', 'para-2', 'para-3']);
 * // result.narrationParagraphs: ['First paragraph with Doctor Smith.', 'Second paragraph.', 'Combined paragraphs.']
 * // result.mapping: [
 * //   { narrationIndex: 0, originalIndices: [0] },
 * //   { narrationIndex: 1, originalIndices: [1] },
 * //   { narrationIndex: 2, originalIndices: [2, 3] },
 * // ]
 */
export function parseNarrationOutput(
  llmOutput: string,
  paragraphOrder: string[]
): ParagraphMapping {
  // Handle empty input
  if (!llmOutput || llmOutput.trim() === "") {
    return {
      narrationParagraphs: [],
      mapping: [],
    };
  }

  // Normalize line endings (Windows \r\n -> Unix \n)
  const normalizedOutput = llmOutput.replace(/\r\n/g, "\n");

  // Split into paragraphs by double newline (or more)
  const rawParagraphs = normalizedOutput
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // Check if any markers exist in the output
  const hasMarkers = PARA_MARKER_REGEX.test(llmOutput);
  // Reset regex after test
  PARA_MARKER_REGEX.lastIndex = 0;

  // If no markers found, use positional mapping
  if (!hasMarkers) {
    return createPositionalMappingResult(rawParagraphs, paragraphOrder.length);
  }

  const narrationParagraphs: string[] = [];
  const mapping: NarrationToOriginal[] = [];

  rawParagraphs.forEach((para) => {
    // Extract all markers from this paragraph
    const indices: number[] = [];
    let match;

    // Reset regex for each paragraph
    PARA_MARKER_REGEX.lastIndex = 0;

    while ((match = PARA_MARKER_REGEX.exec(para)) !== null) {
      const index = parseInt(match[1], 10);
      // Avoid duplicates in case of repeated markers
      if (!indices.includes(index)) {
        indices.push(index);
      }
    }

    // Remove all markers from text
    PARA_MARKER_REGEX.lastIndex = 0;
    const cleanText = para.replace(PARA_MARKER_REGEX, "").trim();

    // Only add non-empty paragraphs
    if (cleanText.length > 0) {
      const narrationIndex = narrationParagraphs.length;
      narrationParagraphs.push(cleanText);

      // If no markers found in this paragraph but others have markers,
      // use the narration index as a fallback
      const originalIndices =
        indices.length > 0
          ? indices.sort((a, b) => a - b)
          : [Math.min(narrationIndex, paragraphOrder.length - 1)];

      mapping.push({
        narrationIndex,
        originalIndices,
      });
    }
  });

  return { narrationParagraphs, mapping };
}

/**
 * Creates a positional mapping result when no markers are present.
 * This is used as a fallback when the LLM doesn't return markers.
 *
 * @param narrationParagraphs - Array of cleaned narration paragraphs
 * @param originalParagraphCount - Number of paragraphs in the original content
 * @returns ParagraphMapping with 1:1 positional mapping
 */
function createPositionalMappingResult(
  narrationParagraphs: string[],
  originalParagraphCount: number
): ParagraphMapping {
  // Remove any accidental markers that might be in the text
  const cleanedParagraphs = narrationParagraphs.map((p) => p.replace(PARA_MARKER_REGEX, "").trim());

  const mapping = createPositionalMapping(cleanedParagraphs.length, originalParagraphCount);

  return {
    narrationParagraphs: cleanedParagraphs,
    mapping,
  };
}

/**
 * Creates a positional mapping for narration paragraphs to original paragraphs.
 *
 * This is used as a fallback when the LLM doesn't return `[PARA:X]` markers.
 * It creates a simple 1:1 mapping where each narration paragraph is assumed
 * to correspond to the original paragraph at the same index.
 *
 * If there are more narration paragraphs than original paragraphs, the extra
 * narration paragraphs are mapped to the last original paragraph.
 *
 * @param narrationParagraphCount - Number of paragraphs in the narration
 * @param originalParagraphCount - Number of paragraphs in the original content
 * @returns Array of mappings from narration index to original indices
 *
 * @example
 * const mapping = createPositionalMapping(3, 5);
 * // Returns: [
 * //   { narrationIndex: 0, originalIndices: [0] },
 * //   { narrationIndex: 1, originalIndices: [1] },
 * //   { narrationIndex: 2, originalIndices: [2] },
 * // ]
 *
 * @example
 * // When narration has more paragraphs than original:
 * const mapping = createPositionalMapping(5, 3);
 * // Returns: [
 * //   { narrationIndex: 0, originalIndices: [0] },
 * //   { narrationIndex: 1, originalIndices: [1] },
 * //   { narrationIndex: 2, originalIndices: [2] },
 * //   { narrationIndex: 3, originalIndices: [2] }, // capped at last original
 * //   { narrationIndex: 4, originalIndices: [2] }, // capped at last original
 * // ]
 */
export function createPositionalMapping(
  narrationParagraphCount: number,
  originalParagraphCount: number
): NarrationToOriginal[] {
  // Handle edge cases
  if (narrationParagraphCount <= 0) {
    return [];
  }

  if (originalParagraphCount <= 0) {
    // If no original paragraphs, map all to index 0
    return Array.from({ length: narrationParagraphCount }, (_, i) => ({
      narrationIndex: i,
      originalIndices: [0],
    }));
  }

  const mapping: NarrationToOriginal[] = [];
  const maxOriginalIndex = originalParagraphCount - 1;

  for (let i = 0; i < narrationParagraphCount; i++) {
    // Cap at the last original paragraph index
    const originalIndex = Math.min(i, maxOriginalIndex);
    mapping.push({
      narrationIndex: i,
      originalIndices: [originalIndex],
    });
  }

  return mapping;
}

/**
 * Strips all [PARA:X] markers from a string.
 *
 * Utility function for cleaning narration text after parsing.
 *
 * @param text - Text containing markers to strip
 * @returns Text with all markers removed
 *
 * @example
 * stripMarkers("[PARA:0]Hello [PARA:1]world");
 * // Returns: "Hello world"
 */
export function stripMarkers(text: string): string {
  return text.replace(PARA_MARKER_REGEX, "").trim();
}

/**
 * Checks if the given text contains any [PARA:X] markers.
 *
 * @param text - Text to check for markers
 * @returns true if markers are found, false otherwise
 *
 * @example
 * hasParaMarkers("[PARA:0]Hello"); // true
 * hasParaMarkers("Hello world");    // false
 */
export function hasParaMarkers(text: string): boolean {
  // Use a fresh regex to avoid lastIndex issues
  return /\[PARA:\d+\]/.test(text);
}
