/**
 * Test to ensure server-side and client-side paragraph ID assignment is consistent.
 *
 * This is critical for narration highlighting to work correctly - the paragraph IDs
 * assigned on the server (for narration generation) must match the IDs assigned on
 * the client (for highlighting).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from "vitest";
import { htmlToNarrationInput } from "../../src/lib/narration/html-to-narration-input";
import { addParagraphIdsToHtml } from "../../src/lib/narration/client-paragraph-ids";

describe("paragraph ID consistency between server and client", () => {
  it("should produce the same paragraph count and order for standalone images", () => {
    const html = '<p>1</p><img alt="2"><p>3</p>';

    // Server-side processing
    const serverResult = htmlToNarrationInput(html);

    // Client-side processing
    const clientResult = addParagraphIdsToHtml(html);

    // Should produce same paragraph count
    expect(serverResult.paragraphOrder.length).toBe(clientResult.paragraphCount);
    expect(serverResult.paragraphOrder.length).toBe(3); // p, img, p

    // Check server-side order
    expect(serverResult.paragraphOrder).toEqual(["para-0", "para-1", "para-2"]);

    // Verify client-side HTML has matching IDs
    expect(clientResult.html).toContain('data-para-id="para-0"');
    expect(clientResult.html).toContain('data-para-id="para-1"');
    expect(clientResult.html).toContain('data-para-id="para-2"');
  });

  it("should handle mix of paragraphs, images, and headings", () => {
    const html = '<h2>Title</h2><p>First</p><img alt="pic"><p>Second</p>';

    const serverResult = htmlToNarrationInput(html);
    const clientResult = addParagraphIdsToHtml(html);

    expect(serverResult.paragraphOrder.length).toBe(clientResult.paragraphCount);
    expect(serverResult.paragraphOrder.length).toBe(4); // h2, p, img, p
  });

  it("should exclude images inside paragraphs", () => {
    const html = '<p>Text <img alt="inline"> more text</p><p>Next</p>';

    const serverResult = htmlToNarrationInput(html);
    const clientResult = addParagraphIdsToHtml(html);

    // Should only have 2 paragraphs (inline image shouldn't get its own ID)
    expect(serverResult.paragraphOrder.length).toBe(clientResult.paragraphCount);
    expect(serverResult.paragraphOrder.length).toBe(2); // p, p
  });

  it("should exclude images inside figures", () => {
    const html = '<p>Before</p><figure><img alt="fig"></figure><p>After</p>';

    const serverResult = htmlToNarrationInput(html);
    const clientResult = addParagraphIdsToHtml(html);

    // Should have 3 elements: p, figure, p (not the img inside figure)
    expect(serverResult.paragraphOrder.length).toBe(clientResult.paragraphCount);
    expect(serverResult.paragraphOrder.length).toBe(3); // p, figure, p
  });

  it("should handle complex article with multiple standalone images", () => {
    const html = `
      <h1>Article Title</h1>
      <p>Introduction paragraph.</p>
      <img alt="First image">
      <p>Middle paragraph.</p>
      <img alt="Second image">
      <p>Conclusion paragraph.</p>
    `;

    const serverResult = htmlToNarrationInput(html);
    const clientResult = addParagraphIdsToHtml(html);

    // h1, p, img, p, img, p = 6 elements
    expect(serverResult.paragraphOrder.length).toBe(clientResult.paragraphCount);
    expect(serverResult.paragraphOrder.length).toBe(6);
  });
});
