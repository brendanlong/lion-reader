/**
 * Unit tests for HTML preprocessing for narration highlighting.
 */

import { describe, it, expect } from "vitest";
import {
  preprocessHtmlForNarration,
  isBlockElement,
  BLOCK_ELEMENTS,
} from "../../src/lib/narration/html-preprocessing";

describe("preprocessHtmlForNarration", () => {
  describe("basic paragraphs", () => {
    it("marks a single paragraph", () => {
      const html = "<p>Hello, world!</p>";
      const result = preprocessHtmlForNarration(html);

      expect(result.paragraphElements).toEqual(["para-0"]);
      expect(result.markedHtml).toContain('data-para-id="para-0"');
      expect(result.markedHtml).toContain("Hello, world!");
    });

    it("marks multiple paragraphs in document order", () => {
      const html = "<p>First</p><p>Second</p><p>Third</p>";
      const result = preprocessHtmlForNarration(html);

      expect(result.paragraphElements).toEqual(["para-0", "para-1", "para-2"]);
      expect(result.markedHtml).toContain('data-para-id="para-0"');
      expect(result.markedHtml).toContain('data-para-id="para-1"');
      expect(result.markedHtml).toContain('data-para-id="para-2"');
    });

    it("preserves paragraph content", () => {
      const html = "<p>Some <strong>bold</strong> and <em>italic</em> text.</p>";
      const result = preprocessHtmlForNarration(html);

      expect(result.paragraphElements).toEqual(["para-0"]);
      expect(result.markedHtml).toContain("<strong>bold</strong>");
      expect(result.markedHtml).toContain("<em>italic</em>");
    });

    it("preserves existing attributes on elements", () => {
      const html = '<p class="intro" id="first">First paragraph</p>';
      const result = preprocessHtmlForNarration(html);

      expect(result.paragraphElements).toEqual(["para-0"]);
      expect(result.markedHtml).toContain('class="intro"');
      expect(result.markedHtml).toContain('id="first"');
      expect(result.markedHtml).toContain('data-para-id="para-0"');
    });
  });

  describe("multiple element types", () => {
    it("marks heading elements (h1-h6)", () => {
      const html = `
        <h1>Heading 1</h1>
        <h2>Heading 2</h2>
        <h3>Heading 3</h3>
        <h4>Heading 4</h4>
        <h5>Heading 5</h5>
        <h6>Heading 6</h6>
      `;
      const result = preprocessHtmlForNarration(html);

      expect(result.paragraphElements).toHaveLength(6);
      expect(result.paragraphElements).toEqual([
        "para-0",
        "para-1",
        "para-2",
        "para-3",
        "para-4",
        "para-5",
      ]);
    });

    it("marks pre and blockquote elements", () => {
      const html = `
        <p>Introduction</p>
        <pre><code>const x = 1;</code></pre>
        <blockquote>A famous quote</blockquote>
        <p>Conclusion</p>
      `;
      const result = preprocessHtmlForNarration(html);

      expect(result.paragraphElements).toEqual(["para-0", "para-1", "para-2", "para-3"]);
      expect(result.markedHtml).toContain("<pre data-para-id");
      expect(result.markedHtml).toContain("<blockquote data-para-id");
    });

    it("marks figure, img, and table elements", () => {
      const html = `
        <p>Before image</p>
        <figure><img src="test.jpg" alt="Test"><figcaption>Caption</figcaption></figure>
        <table><tr><td>Cell</td></tr></table>
        <p>After table</p>
      `;
      const result = preprocessHtmlForNarration(html);

      // p, figure, img (inside figure), table, p = 5 elements
      expect(result.paragraphElements).toEqual(["para-0", "para-1", "para-2", "para-3", "para-4"]);
      expect(result.markedHtml).toContain("<figure data-para-id");
      expect(result.markedHtml).toContain("<img data-para-id");
      expect(result.markedHtml).toContain("<table data-para-id");
    });

    it("marks mixed element types in document order", () => {
      const html = `
        <h1>Title</h1>
        <p>Introduction paragraph.</p>
        <h2>Section</h2>
        <blockquote>A quote</blockquote>
        <pre>code</pre>
        <p>Final paragraph.</p>
      `;
      const result = preprocessHtmlForNarration(html);

      expect(result.paragraphElements).toEqual([
        "para-0",
        "para-1",
        "para-2",
        "para-3",
        "para-4",
        "para-5",
      ]);

      // Verify order by checking substrings
      const h1Index = result.markedHtml.indexOf('<h1 data-para-id="para-0"');
      const firstPIndex = result.markedHtml.indexOf('<p data-para-id="para-1"');
      const h2Index = result.markedHtml.indexOf('<h2 data-para-id="para-2"');
      const blockquoteIndex = result.markedHtml.indexOf('<blockquote data-para-id="para-3"');
      const preIndex = result.markedHtml.indexOf('<pre data-para-id="para-4"');
      const lastPIndex = result.markedHtml.indexOf('<p data-para-id="para-5"');

      expect(h1Index).toBeLessThan(firstPIndex);
      expect(firstPIndex).toBeLessThan(h2Index);
      expect(h2Index).toBeLessThan(blockquoteIndex);
      expect(blockquoteIndex).toBeLessThan(preIndex);
      expect(preIndex).toBeLessThan(lastPIndex);
    });
  });

  describe("nested lists", () => {
    it("marks ul and li elements", () => {
      const html = `
        <ul>
          <li>Item 1</li>
          <li>Item 2</li>
          <li>Item 3</li>
        </ul>
      `;
      const result = preprocessHtmlForNarration(html);

      // ul and 3 li elements = 4 total
      expect(result.paragraphElements).toHaveLength(4);
      expect(result.markedHtml).toContain("<ul data-para-id");
      expect(result.markedHtml).toContain("<li data-para-id");
    });

    it("marks ol and li elements", () => {
      const html = `
        <ol>
          <li>First</li>
          <li>Second</li>
        </ol>
      `;
      const result = preprocessHtmlForNarration(html);

      // ol and 2 li elements = 3 total
      expect(result.paragraphElements).toHaveLength(3);
      expect(result.markedHtml).toContain("<ol data-para-id");
      expect(result.markedHtml).toContain("<li data-para-id");
    });

    it("marks nested lists correctly", () => {
      const html = `
        <ul>
          <li>Parent 1
            <ul>
              <li>Child 1.1</li>
              <li>Child 1.2</li>
            </ul>
          </li>
          <li>Parent 2</li>
        </ul>
      `;
      const result = preprocessHtmlForNarration(html);

      // Outer ul + parent li + inner ul + 2 child li + parent li = 6 total
      expect(result.paragraphElements).toHaveLength(6);
    });

    it("assigns IDs in document order for nested lists", () => {
      const html = `
        <p>Before list</p>
        <ul>
          <li>Item 1</li>
          <li>Item 2</li>
        </ul>
        <p>After list</p>
      `;
      const result = preprocessHtmlForNarration(html);

      // p, ul, li, li, p = 5 elements
      expect(result.paragraphElements).toEqual(["para-0", "para-1", "para-2", "para-3", "para-4"]);

      // Verify p comes before ul in the output
      const pIndex = result.markedHtml.indexOf('<p data-para-id="para-0"');
      const ulIndex = result.markedHtml.indexOf('<ul data-para-id="para-1"');
      expect(pIndex).toBeLessThan(ulIndex);
    });
  });

  describe("empty content", () => {
    it("handles empty string", () => {
      const result = preprocessHtmlForNarration("");

      expect(result.markedHtml).toBe("");
      expect(result.paragraphElements).toEqual([]);
    });

    it("handles whitespace-only string", () => {
      const result = preprocessHtmlForNarration("   \n\t  ");

      expect(result.markedHtml).toBe("");
      expect(result.paragraphElements).toEqual([]);
    });

    it("handles HTML with no block elements", () => {
      const html = "<span>Inline text</span><a href='#'>Link</a>";
      const result = preprocessHtmlForNarration(html);

      expect(result.paragraphElements).toEqual([]);
      expect(result.markedHtml).toContain("Inline text");
      expect(result.markedHtml).toContain("Link");
    });

    it("handles empty paragraph elements", () => {
      const html = "<p></p><p>Has content</p><p></p>";
      const result = preprocessHtmlForNarration(html);

      // Empty paragraphs still get IDs
      expect(result.paragraphElements).toEqual(["para-0", "para-1", "para-2"]);
    });
  });

  describe("edge cases", () => {
    it("handles deeply nested content", () => {
      const html = `
        <div>
          <article>
            <section>
              <p>Deeply nested paragraph</p>
            </section>
          </article>
        </div>
      `;
      const result = preprocessHtmlForNarration(html);

      expect(result.paragraphElements).toEqual(["para-0"]);
      expect(result.markedHtml).toContain('data-para-id="para-0"');
    });

    it("handles inline elements within block elements", () => {
      const html = `
        <p>Text with <a href="#">link</a> and <code>code</code>.</p>
      `;
      const result = preprocessHtmlForNarration(html);

      expect(result.paragraphElements).toEqual(["para-0"]);
      expect(result.markedHtml).toContain("<a href=");
      expect(result.markedHtml).toContain("<code>");
    });

    it("handles self-closing elements", () => {
      const html = `
        <p>Before</p>
        <figure><img src="test.jpg" /></figure>
        <p>After</p>
      `;
      const result = preprocessHtmlForNarration(html);

      // p, figure, img (inside figure), p = 4 elements
      expect(result.paragraphElements).toEqual(["para-0", "para-1", "para-2", "para-3"]);
    });

    it("handles HTML entities", () => {
      const html = "<p>Less &lt; than &amp; greater &gt; than</p>";
      const result = preprocessHtmlForNarration(html);

      expect(result.paragraphElements).toEqual(["para-0"]);
      expect(result.markedHtml).toContain("&lt;");
      expect(result.markedHtml).toContain("&amp;");
      expect(result.markedHtml).toContain("&gt;");
    });

    it("handles special characters in content", () => {
      const html = "<p>Hello \"world\" with 'quotes' and unicode: </p>";
      const result = preprocessHtmlForNarration(html);

      expect(result.paragraphElements).toEqual(["para-0"]);
      // Content should be preserved
      expect(result.markedHtml).toContain("Hello");
      expect(result.markedHtml).toContain("unicode");
    });

    it("handles multiple adjacent block elements without whitespace", () => {
      const html = "<p>One</p><p>Two</p><h2>Three</h2>";
      const result = preprocessHtmlForNarration(html);

      expect(result.paragraphElements).toEqual(["para-0", "para-1", "para-2"]);
    });

    it("does not mark non-block elements", () => {
      const html = `
        <p>Paragraph</p>
        <div>Not a block element for narration</div>
        <span>Also not marked</span>
        <section>Section not marked</section>
        <article>Article not marked</article>
      `;
      const result = preprocessHtmlForNarration(html);

      // Only p should be marked
      expect(result.paragraphElements).toEqual(["para-0"]);
      expect(result.markedHtml).not.toContain("<div data-para-id");
      expect(result.markedHtml).not.toContain("<span data-para-id");
      expect(result.markedHtml).not.toContain("<section data-para-id");
      expect(result.markedHtml).not.toContain("<article data-para-id");
    });
  });

  describe("realistic article content", () => {
    it("handles a typical blog post structure", () => {
      const html = `
        <h1>How to Write Tests</h1>
        <p>Testing is important for software quality.</p>
        <h2>Unit Tests</h2>
        <p>Unit tests verify individual functions.</p>
        <pre><code>function add(a, b) { return a + b; }</code></pre>
        <h2>Integration Tests</h2>
        <p>Integration tests verify components work together.</p>
        <blockquote>
          <p>Good tests are like documentation.</p>
        </blockquote>
        <h2>Summary</h2>
        <ul>
          <li>Write unit tests for logic</li>
          <li>Write integration tests for I/O</li>
          <li>Use meaningful assertions</li>
        </ul>
        <p>Happy testing!</p>
      `;
      const result = preprocessHtmlForNarration(html);

      // Count: h1 + p + h2 + p + pre + h2 + p + blockquote + p + h2 + ul + 3*li + p = 15
      expect(result.paragraphElements.length).toBe(15);

      // All should be in order from para-0 to para-14
      expect(result.paragraphElements[0]).toBe("para-0");
      expect(result.paragraphElements[14]).toBe("para-14");

      // Verify structure is preserved
      expect(result.markedHtml).toContain("<h1 data-para-id");
      expect(result.markedHtml).toContain("<h2 data-para-id");
      expect(result.markedHtml).toContain("<pre data-para-id");
      expect(result.markedHtml).toContain("<blockquote data-para-id");
      expect(result.markedHtml).toContain("<ul data-para-id");
      expect(result.markedHtml).toContain("<li data-para-id");
    });

    it("handles article with code snippets and quotes", () => {
      const html = `
        <p>Consider this example:</p>
        <pre><code>const result = await fetchData();
console.log(result);</code></pre>
        <p>As the documentation states:</p>
        <blockquote>
          <p>"Always handle errors gracefully."</p>
        </blockquote>
        <p>Keep this in mind.</p>
      `;
      const result = preprocessHtmlForNarration(html);

      // p + pre + p + blockquote + p + p = 6
      expect(result.paragraphElements.length).toBe(6);

      // Code content should be preserved
      expect(result.markedHtml).toContain("await fetchData()");
      expect(result.markedHtml).toContain("console.log");
    });
  });
});

describe("isBlockElement", () => {
  it("returns true for all block elements", () => {
    BLOCK_ELEMENTS.forEach((tag) => {
      expect(isBlockElement(tag)).toBe(true);
    });
  });

  it("returns true for uppercase variants", () => {
    expect(isBlockElement("P")).toBe(true);
    expect(isBlockElement("H1")).toBe(true);
    expect(isBlockElement("BLOCKQUOTE")).toBe(true);
    expect(isBlockElement("PRE")).toBe(true);
  });

  it("returns false for non-block elements", () => {
    expect(isBlockElement("div")).toBe(false);
    expect(isBlockElement("span")).toBe(false);
    expect(isBlockElement("a")).toBe(false);
    expect(isBlockElement("section")).toBe(false);
    expect(isBlockElement("article")).toBe(false);
  });
});
