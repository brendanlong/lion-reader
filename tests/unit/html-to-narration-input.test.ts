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
    it("extracts paragraphs with IDs and text", () => {
      const html = "<p>First paragraph.</p><p>Second paragraph.</p>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([
        { id: 0, text: "First paragraph." },
        { id: 1, text: "Second paragraph." },
      ]);
    });

    it("returns paragraphs with sequential IDs", () => {
      const html = "<p>First.</p><p>Second.</p><p>Third.</p>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([
        { id: 0, text: "First." },
        { id: 1, text: "Second." },
        { id: 2, text: "Third." },
      ]);
    });

    it("handles empty HTML", () => {
      const result = htmlToNarrationInput("");

      expect(result.paragraphs).toEqual([]);
    });

    it("handles HTML with only whitespace", () => {
      const result = htmlToNarrationInput("   \n\n   ");

      expect(result.paragraphs).toEqual([]);
    });
  });

  describe("heading handling", () => {
    it("extracts h1 headings", () => {
      const html = "<h1>Main Title</h1>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([{ id: 0, text: "Main Title" }]);
    });

    it("extracts h2 headings", () => {
      const html = "<h2>Section Title</h2>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([{ id: 0, text: "Section Title" }]);
    });

    it("extracts h3 headings", () => {
      const html = "<h3>Subsection</h3>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([{ id: 0, text: "Subsection" }]);
    });

    it("extracts h4-h6 headings", () => {
      const html = "<h4>Minor heading</h4><h5>Smaller</h5><h6>Smallest</h6>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([
        { id: 0, text: "Minor heading" },
        { id: 1, text: "Smaller" },
        { id: 2, text: "Smallest" },
      ]);
    });
  });

  describe("code block handling", () => {
    it("marks code blocks with 'Code block:' prefix", () => {
      const html = "<pre><code>npm install</code></pre>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([
        { id: 0, text: "Code block: npm install End code block." },
      ]);
    });

    it("handles pre without code tag", () => {
      const html = "<pre>console.log('hello');</pre>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([
        { id: 0, text: "Code block: console.log('hello'); End code block." },
      ]);
    });

    it("handles inline code within paragraph", () => {
      const html = "<p>Use the <code>npm</code> command.</p>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([{ id: 0, text: "Use the `npm` command." }]);
    });
  });

  describe("blockquote handling", () => {
    it("marks blockquotes with 'Quote:' prefix", () => {
      const html = "<blockquote>A famous quote.</blockquote>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([{ id: 0, text: "Quote: A famous quote. End quote." }]);
    });
  });

  describe("image handling", () => {
    it("marks figures containing images", () => {
      const html = '<figure><img src="photo.jpg" alt="A beautiful sunset"></figure>';
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([{ id: 0, text: "Image: A beautiful sunset" }]);
    });

    it("handles inline images within paragraphs", () => {
      const html = '<p>Look at this: <img src="photo.jpg" alt="A photo"></p>';
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([{ id: 0, text: "Look at this: Image: A photo" }]);
    });
  });

  describe("link handling", () => {
    it("preserves link text", () => {
      const html = '<p>Check out <a href="https://example.com">this link</a>.</p>';
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([{ id: 0, text: "Check out this link." }]);
    });

    it("converts URL-only links to domain mention", () => {
      const html = '<p>Visit <a href="https://example.com">https://example.com</a>.</p>';
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([{ id: 0, text: "Visit [link to example.com]." }]);
    });

    it("converts empty link text to domain mention", () => {
      const html = '<p>Visit <a href="https://example.com"></a> for more.</p>';
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([{ id: 0, text: "Visit [link to example.com] for more." }]);
    });
  });

  describe("list handling", () => {
    it("marks list containers and items", () => {
      const html = "<ul><li>First item</li><li>Second item</li></ul>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([
        { id: 1, text: "- First item" },
        { id: 2, text: "- Second item" },
      ]);
    });

    it("handles ordered lists", () => {
      const html = "<ol><li>Step one</li><li>Step two</li></ol>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([
        { id: 1, text: "- Step one" },
        { id: 2, text: "- Step two" },
      ]);
    });
  });

  describe("table handling", () => {
    it("marks tables with 'Table:' prefix", () => {
      const html = "<table><tr><td>Cell 1</td><td>Cell 2</td></tr></table>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([{ id: 0, text: "Table: Cell 1, Cell 2 End table." }]);
    });
  });

  describe("mixed content", () => {
    it("processes elements in document order", () => {
      const html = `
        <h1>Title</h1>
        <p>Introduction paragraph.</p>
        <pre><code>example code</code></pre>
        <p>Another paragraph.</p>
      `;
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([
        { id: 0, text: "Title" },
        { id: 1, text: "Introduction paragraph." },
        { id: 2, text: "Code block: example code End code block." },
        { id: 3, text: "Another paragraph." },
      ]);
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

      expect(result.paragraphs).toEqual([
        { id: 0, text: "Article Title" },
        { id: 1, text: "By Dr. Smith" },
        { id: 2, text: "Introduction" },
        { id: 3, text: "This is the introduction." },
        { id: 5, text: "- Point one" },
        { id: 6, text: "- Point two" },
        { id: 7, text: "Quote: A memorable quote. End quote." },
        { id: 8, text: "Final thoughts." },
      ]);
    });
  });

  describe("HTML entity handling", () => {
    it("decodes common HTML entities", () => {
      const html = "<p>Tom &amp; Jerry &lt;3 ice cream &quot;yum&quot;</p>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([{ id: 0, text: 'Tom & Jerry <3 ice cream "yum"' }]);
    });

    it("handles nbsp", () => {
      const html = "<p>Hello&nbsp;World</p>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([{ id: 0, text: "Hello World" }]);
    });
  });

  describe("whitespace normalization", () => {
    it("collapses multiple spaces", () => {
      const html = "<p>Too    many    spaces</p>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([{ id: 0, text: "Too many spaces" }]);
    });

    it("handles multiple paragraphs", () => {
      const html = "<p>First</p>\n\n\n\n<p>Second</p>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([
        { id: 0, text: "First" },
        { id: 1, text: "Second" },
      ]);
    });

    it("trims whitespace", () => {
      const html = "<p>  Trimmed content  </p>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([{ id: 0, text: "Trimmed content" }]);
    });
  });

  describe("div handling", () => {
    it("does not add separate entries for divs (they are containers)", () => {
      const html = "<div><p>Content inside div</p></div>";
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toEqual([{ id: 0, text: "Content inside div" }]);
    });
  });

  describe("br handling", () => {
    it("extracts text from paragraph with br (br treated as inline)", () => {
      const html = "<p>Line one<br>Line two</p>";
      const result = htmlToNarrationInput(html);

      // DOM-based parsing treats br as inline, text is joined
      expect(result.paragraphs).toEqual([{ id: 0, text: "Line oneLine two" }]);
    });
  });
});
