/**
 * Test htmlToPlainText handling of images.
 *
 * Ensures that images are properly converted to text placeholders
 * so that the paragraph count matches between client and fallback narration.
 */

import { describe, it, expect } from "vitest";
import { htmlToPlainText } from "../../src/lib/narration/html-to-narration-input";

describe("htmlToPlainText image handling", () => {
  it("should convert standalone images with alt text to text placeholders", () => {
    const html = '<p>Before</p><img src="test.jpg" alt="A test image"><p>After</p>';
    const result = htmlToPlainText(html);

    expect(result).toContain("Before");
    expect(result).toContain("Image: A test image");
    expect(result).toContain("After");

    // Should have 3 paragraphs when split
    const paragraphs = result.split("\n\n").filter((p) => p.trim().length > 0);
    expect(paragraphs).toHaveLength(3);
  });

  it("should convert standalone images without alt text to generic placeholders", () => {
    const html = '<p>Before</p><img src="test.jpg"><p>After</p>';
    const result = htmlToPlainText(html);

    expect(result).toContain("Before");
    expect(result).toContain("Image");
    expect(result).toContain("After");

    const paragraphs = result.split("\n\n").filter((p) => p.trim().length > 0);
    expect(paragraphs).toHaveLength(3);
  });

  it("should handle multiple standalone images", () => {
    const html = `
      <p>Paragraph 1</p>
      <img alt="First image">
      <p>Paragraph 2</p>
      <img alt="Second image">
      <p>Paragraph 3</p>
    `;
    const result = htmlToPlainText(html);

    expect(result).toContain("Paragraph 1");
    expect(result).toContain("Image: First image");
    expect(result).toContain("Paragraph 2");
    expect(result).toContain("Image: Second image");
    expect(result).toContain("Paragraph 3");

    const paragraphs = result.split("\n\n").filter((p) => p.trim().length > 0);
    expect(paragraphs).toHaveLength(5); // 3 paragraphs + 2 images
  });

  it("should handle images inside paragraphs as inline content", () => {
    const html = '<p>Text with <img alt="inline image"> more text</p>';
    const result = htmlToPlainText(html);

    // Inline images become text within the paragraph
    expect(result).toContain("Text with");
    expect(result).toContain("Image: inline image");
    expect(result).toContain("more text");
  });

  it("should match paragraph count from client-side processing", () => {
    // This is the key test: ensure fallback narration has same paragraph count as client IDs
    const html = '<p>1</p><img alt="2"><p>3</p>';
    const result = htmlToPlainText(html);

    const paragraphs = result.split("\n\n").filter((p) => p.trim().length > 0);

    // Should have 3 paragraphs: p, img, p
    // This matches the 3 paragraph IDs that client-side will assign
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]).toBe("1");
    expect(paragraphs[1]).toBe("Image: 2");
    expect(paragraphs[2]).toBe("3");
  });

  it("should handle complex scenarios with mixed content", () => {
    const html = `
      <h1>Title</h1>
      <p>Intro</p>
      <img alt="diagram">
      <p>Explanation</p>
      <figure><img alt="figure image"></figure>
      <p>Conclusion</p>
    `;
    const result = htmlToPlainText(html);

    expect(result).toContain("Title");
    expect(result).toContain("Intro");
    expect(result).toContain("Image: diagram"); // standalone image
    expect(result).toContain("Explanation");
    expect(result).toContain("Image: figure image"); // image in figure
    expect(result).toContain("Conclusion");
  });
});
