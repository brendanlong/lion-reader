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

    // Should have 4 paragraph IDs: p, img, p, p
    expect(result.paragraphOrder).toEqual(["para-0", "para-1", "para-2", "para-3"]);

    // Should include alt text in narration
    expect(result.inputText).toContain("[P:0] 1");
    expect(result.inputText).toContain("[P:1] [IMAGE: image description]");
    expect(result.inputText).toContain("[P:2] 2");
    expect(result.inputText).toContain("[P:3] 3");
  });

  it("should handle standalone img without alt text", () => {
    const html = "<p>1</p><img><p>2</p>";
    const result = htmlToNarrationInput(html);

    // Should have 3 paragraph IDs
    expect(result.paragraphOrder).toEqual(["para-0", "para-1", "para-2"]);

    // Should use default description
    expect(result.inputText).toContain("[P:1] [IMAGE: image]");
  });

  it("should handle mix of standalone and figure-wrapped images", () => {
    const html = `
      <p>Paragraph 1</p>
      <img alt="standalone image">
      <figure><img alt="figure image"></figure>
      <p>Paragraph 2</p>
    `;
    const result = htmlToNarrationInput(html);

    // Should have 4 paragraph IDs: p, img, figure, p
    expect(result.paragraphOrder).toHaveLength(4);

    // Both images should be in narration
    expect(result.inputText).toContain("[IMAGE: standalone image]");
    expect(result.inputText).toContain("[IMAGE: figure image]");
  });
});
