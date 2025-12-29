/**
 * Unit tests for htmlToNarrationInput function.
 *
 * Tests the paragraph marker generation and text preprocessing
 * for LLM narration generation.
 */

import { describe, it, expect } from "vitest";
import { htmlToNarrationInput } from "../../src/lib/narration/html-to-narration-input";

describe("htmlToNarrationInput", () => {
  describe("basic paragraph handling", () => {
    it("adds [P:X] markers to paragraphs", () => {
      const html = "<p>First paragraph.</p><p>Second paragraph.</p>";
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain("[P:0]");
      expect(result.inputText).toContain("[P:1]");
      expect(result.inputText).toContain("First paragraph.");
      expect(result.inputText).toContain("Second paragraph.");
    });

    it("returns paragraphOrder with correct IDs", () => {
      const html = "<p>First.</p><p>Second.</p><p>Third.</p>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphOrder).toEqual(["para-0", "para-1", "para-2"]);
    });

    it("handles empty HTML", () => {
      const result = htmlToNarrationInput("");

      expect(result.inputText).toBe("");
      expect(result.paragraphOrder).toEqual([]);
    });

    it("handles HTML with only whitespace", () => {
      const result = htmlToNarrationInput("   \n\n   ");

      expect(result.inputText).toBe("");
      expect(result.paragraphOrder).toEqual([]);
    });
  });

  describe("heading handling", () => {
    it("marks h1 headings with [HEADING] and paragraph marker", () => {
      const html = "<h1>Main Title</h1>";
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain("[P:0] [HEADING] Main Title");
      expect(result.paragraphOrder).toEqual(["para-0"]);
    });

    it("marks h2 headings with [HEADING] and paragraph marker", () => {
      const html = "<h2>Section Title</h2>";
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain("[P:0] [HEADING] Section Title");
      expect(result.paragraphOrder).toEqual(["para-0"]);
    });

    it("marks h3 headings with [SUBHEADING] and paragraph marker", () => {
      const html = "<h3>Subsection</h3>";
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain("[P:0] [SUBHEADING] Subsection");
      expect(result.paragraphOrder).toEqual(["para-0"]);
    });

    it("marks h4-h6 headings with [SUBHEADING] and paragraph marker", () => {
      const html = "<h4>Minor heading</h4><h5>Smaller</h5><h6>Smallest</h6>";
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain("[P:0] [SUBHEADING] Minor heading");
      expect(result.inputText).toContain("[P:1] [SUBHEADING] Smaller");
      expect(result.inputText).toContain("[P:2] [SUBHEADING] Smallest");
      expect(result.paragraphOrder).toHaveLength(3);
    });
  });

  describe("code block handling", () => {
    it("marks code blocks with [CODE BLOCK] and paragraph marker", () => {
      const html = "<pre><code>npm install</code></pre>";
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain("[P:0] [CODE BLOCK]");
      expect(result.inputText).toContain("npm install");
      expect(result.inputText).toContain("[END CODE BLOCK]");
      expect(result.paragraphOrder).toEqual(["para-0"]);
    });

    it("handles pre without code tag", () => {
      const html = "<pre>console.log('hello');</pre>";
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain("[P:0] [CODE BLOCK]");
      expect(result.inputText).toContain("console.log('hello');");
      expect(result.paragraphOrder).toEqual(["para-0"]);
    });

    it("handles inline code without paragraph marker", () => {
      const html = "<p>Use the <code>npm</code> command.</p>";
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain("`npm`");
      // Only one paragraph marker for the <p>
      expect(result.paragraphOrder).toHaveLength(1);
    });
  });

  describe("blockquote handling", () => {
    it("marks blockquotes with [QUOTE] and paragraph marker", () => {
      const html = "<blockquote>A famous quote.</blockquote>";
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain("[P:0] [QUOTE]");
      expect(result.inputText).toContain("A famous quote.");
      expect(result.inputText).toContain("[END QUOTE]");
      expect(result.paragraphOrder).toEqual(["para-0"]);
    });
  });

  describe("image handling", () => {
    it("marks figures containing images with paragraph marker", () => {
      const html = '<figure><img src="photo.jpg" alt="A beautiful sunset"></figure>';
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain("[P:0] [IMAGE: A beautiful sunset]");
      expect(result.paragraphOrder).toEqual(["para-0"]);
    });

    it("handles inline images within paragraphs", () => {
      const html = '<p>Look at this: <img src="photo.jpg" alt="A photo"></p>';
      const result = htmlToNarrationInput(html);

      // Image text is included within the paragraph
      expect(result.inputText).toContain("[IMAGE: A photo]");
      // Only one paragraph marker for the <p>
      expect(result.paragraphOrder).toEqual(["para-0"]);
    });
  });

  describe("link handling", () => {
    it("preserves link text without adding markers", () => {
      const html = '<p>Check out <a href="https://example.com">this link</a>.</p>';
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain("Check out this link.");
      // Only one paragraph marker for the <p>
      expect(result.paragraphOrder).toHaveLength(1);
    });

    it("converts URL-only links to domain mention", () => {
      const html = '<p>Visit <a href="https://example.com">https://example.com</a>.</p>';
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain("[link to example.com]");
    });

    it("converts empty link text to domain mention", () => {
      const html = '<p>Visit <a href="https://example.com"></a> for more.</p>';
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain("[link to example.com]");
    });
  });

  describe("list handling", () => {
    it("marks list containers and items with paragraph markers", () => {
      const html = "<ul><li>First item</li><li>Second item</li></ul>";
      const result = htmlToNarrationInput(html);

      // ul gets a marker, and each li gets a marker (3 total)
      expect(result.inputText).toContain("[P:0] [LIST]");
      expect(result.inputText).toContain("[P:1] - First item");
      expect(result.inputText).toContain("[P:2] - Second item");
      expect(result.paragraphOrder).toEqual(["para-0", "para-1", "para-2"]);
    });

    it("handles ordered lists", () => {
      const html = "<ol><li>Step one</li><li>Step two</li></ol>";
      const result = htmlToNarrationInput(html);

      // ol gets a marker, and each li gets a marker (3 total)
      expect(result.inputText).toContain("[P:0] [LIST]");
      expect(result.inputText).toContain("[P:1] - Step one");
      expect(result.inputText).toContain("[P:2] - Step two");
      expect(result.paragraphOrder).toHaveLength(3);
    });
  });

  describe("table handling", () => {
    it("marks tables with [TABLE] and paragraph marker", () => {
      const html = "<table><tr><td>Cell 1</td><td>Cell 2</td></tr></table>";
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain("[P:0] [TABLE]");
      expect(result.inputText).toContain("Cell 1");
      expect(result.inputText).toContain("Cell 2");
      expect(result.inputText).toContain("[END TABLE]");
      expect(result.paragraphOrder).toEqual(["para-0"]);
    });
  });

  describe("mixed content", () => {
    it("assigns markers in document order", () => {
      const html = `
        <h1>Title</h1>
        <p>Introduction paragraph.</p>
        <pre><code>example code</code></pre>
        <p>Another paragraph.</p>
      `;
      const result = htmlToNarrationInput(html);

      // Elements are processed in document order (not by element type)
      expect(result.inputText).toContain("[P:0] [HEADING] Title");
      expect(result.inputText).toContain("[P:1] Introduction paragraph.");
      expect(result.inputText).toContain("[P:2] [CODE BLOCK]");
      expect(result.inputText).toContain("[P:3] Another paragraph.");
      // All 4 elements should have markers
      expect(result.paragraphOrder).toHaveLength(4);
    });

    it("handles complex article structure", () => {
      const html = `
        <h1>Article Title</h1>
        <p>By Dr. Smith</p>
        <h2>Introduction</h2>
        <p>This is the introduction.</p>
        <ul>
          <li>Point one</li>
          <li>Point two</li>
        </ul>
        <blockquote>A memorable quote.</blockquote>
        <p>Final thoughts.</p>
      `;
      const result = htmlToNarrationInput(html);

      // Check all elements are marked (9 total, in document order):
      // - h1 (Article Title)
      // - p (By Dr. Smith)
      // - h2 (Introduction)
      // - p (This is the introduction)
      // - ul (list container)
      // - li (Point one)
      // - li (Point two)
      // - blockquote (A memorable quote)
      // - p (Final thoughts)
      expect(result.paragraphOrder).toHaveLength(9);

      // Verify content is preserved
      expect(result.inputText).toContain("[HEADING] Article Title");
      expect(result.inputText).toContain("[HEADING] Introduction");
      expect(result.inputText).toContain("By Dr. Smith");
      expect(result.inputText).toContain("This is the introduction.");
      expect(result.inputText).toContain("Point one");
      expect(result.inputText).toContain("Point two");
      expect(result.inputText).toContain("A memorable quote.");
      expect(result.inputText).toContain("Final thoughts.");
    });
  });

  describe("HTML entity handling", () => {
    it("decodes common HTML entities", () => {
      const html = "<p>Tom &amp; Jerry &lt;3 ice cream &quot;yum&quot;</p>";
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain('Tom & Jerry <3 ice cream "yum"');
    });

    it("handles nbsp", () => {
      const html = "<p>Hello&nbsp;World</p>";
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain("Hello World");
    });
  });

  describe("whitespace normalization", () => {
    it("collapses multiple spaces", () => {
      const html = "<p>Too    many    spaces</p>";
      const result = htmlToNarrationInput(html);

      expect(result.inputText).toContain("Too many spaces");
    });

    it("collapses multiple newlines", () => {
      const html = "<p>First</p>\n\n\n\n<p>Second</p>";
      const result = htmlToNarrationInput(html);

      // Should have at most 2 newlines between paragraphs
      expect(result.inputText).not.toContain("\n\n\n");
    });

    it("trims lines", () => {
      const html = "<p>  Trimmed content  </p>";
      const result = htmlToNarrationInput(html);

      // Content should be trimmed
      expect(result.inputText).toContain("Trimmed content");
    });
  });

  describe("div handling", () => {
    it("does not add markers to divs (they are containers)", () => {
      const html = "<div><p>Content inside div</p></div>";
      const result = htmlToNarrationInput(html);

      // Only the <p> should get a marker, not the div
      expect(result.paragraphOrder).toHaveLength(1);
      expect(result.inputText).toContain("[P:0] Content inside div");
    });
  });

  describe("br handling", () => {
    it("extracts text from paragraph with br (br treated as inline)", () => {
      const html = "<p>Line one<br>Line two</p>";
      const result = htmlToNarrationInput(html);

      // DOM-based parsing treats br as inline, text is joined
      // The LLM will handle the text appropriately for narration
      expect(result.inputText).toContain("Line one");
      expect(result.inputText).toContain("Line two");
      expect(result.paragraphOrder).toHaveLength(1);
    });
  });
});
