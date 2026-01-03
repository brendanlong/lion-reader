/**
 * Test for standalone image handling in narration.
 *
 * This test verifies that standalone <img> tags (not wrapped in <figure>)
 * are properly included in the narration input with paragraph markers.
 */

import { describe, it, expect } from "vitest";
import { htmlToNarrationInput } from "../../src/lib/narration/html-to-narration-input";

describe("standalone image handling", () => {
  it("should include standalone img tags with paragraph markers", () => {
    const html = '<p>1</p><img alt="image description"><p>2</p><p>3</p>';
    const result = htmlToNarrationInput(html);

    // Should have 4 paragraphs: p, img, p, p
    expect(result.paragraphs).toHaveLength(4);
    expect(result.paragraphs.map((p) => p.id)).toEqual([0, 1, 2, 3]);

    // Should include alt text in narration
    expect(result.paragraphs[0]).toEqual({ id: 0, text: "1" });
    expect(result.paragraphs[1]).toEqual({ id: 1, text: "Image: image description" });
    expect(result.paragraphs[2]).toEqual({ id: 2, text: "2" });
    expect(result.paragraphs[3]).toEqual({ id: 3, text: "3" });
  });

  it("should handle standalone img without alt text", () => {
    const html = "<p>1</p><img><p>2</p>";
    const result = htmlToNarrationInput(html);

    // Should have 3 paragraphs
    expect(result.paragraphs).toHaveLength(3);
    expect(result.paragraphs.map((p) => p.id)).toEqual([0, 1, 2]);

    // Should use default description
    expect(result.paragraphs[1]).toEqual({ id: 1, text: "Image: image" });
  });

  it("should handle mix of standalone and figure-wrapped images", () => {
    const html = `
      <p>Paragraph 1</p>
      <img alt="standalone image">
      <figure><img alt="figure image"></figure>
      <p>Paragraph 2</p>
    `;
    const result = htmlToNarrationInput(html);

    // Should have 4 paragraphs: p, img, figure, p
    expect(result.paragraphs).toHaveLength(4);

    // Both images should be in narration
    expect(result.paragraphs.some((p) => p.text === "Image: standalone image")).toBe(true);
    expect(result.paragraphs.some((p) => p.text === "Image: figure image")).toBe(true);
  });
});
