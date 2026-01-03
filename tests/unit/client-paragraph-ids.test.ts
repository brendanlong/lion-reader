/**
 * Unit tests for client-side paragraph ID processing for narration highlighting.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from "vitest";
import {
  addParagraphIdsToHtml,
  processHtmlForHighlighting,
  createMemoizedAddParagraphIds,
  htmlToClientNarration,
  BLOCK_ELEMENTS,
} from "../../src/lib/narration/client-paragraph-ids";

describe("addParagraphIdsToHtml", () => {
  describe("basic paragraphs", () => {
    it("marks a single paragraph", () => {
      const html = "<p>Hello, world!</p>";
      const result = addParagraphIdsToHtml(html);

      expect(result.paragraphCount).toBe(1);
      expect(result.html).toContain('data-para-id="para-0"');
      expect(result.html).toContain("Hello, world!");
    });

    it("marks multiple paragraphs in document order", () => {
      const html = "<p>First</p><p>Second</p><p>Third</p>";
      const result = addParagraphIdsToHtml(html);

      expect(result.paragraphCount).toBe(3);
      expect(result.html).toContain('data-para-id="para-0"');
      expect(result.html).toContain('data-para-id="para-1"');
      expect(result.html).toContain('data-para-id="para-2"');
    });

    it("preserves paragraph content", () => {
      const html = "<p>Some <strong>bold</strong> and <em>italic</em> text.</p>";
      const result = addParagraphIdsToHtml(html);

      expect(result.paragraphCount).toBe(1);
      expect(result.html).toContain("<strong>bold</strong>");
      expect(result.html).toContain("<em>italic</em>");
    });

    it("preserves existing attributes on elements", () => {
      const html = '<p class="intro" id="first">First paragraph</p>';
      const result = addParagraphIdsToHtml(html);

      expect(result.paragraphCount).toBe(1);
      expect(result.html).toContain('class="intro"');
      expect(result.html).toContain('id="first"');
      expect(result.html).toContain('data-para-id="para-0"');
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
      const result = addParagraphIdsToHtml(html);

      expect(result.paragraphCount).toBe(6);
    });

    it("marks pre and blockquote elements", () => {
      const html = `
        <p>Introduction</p>
        <pre><code>const x = 1;</code></pre>
        <blockquote>A famous quote</blockquote>
        <p>Conclusion</p>
      `;
      const result = addParagraphIdsToHtml(html);

      expect(result.paragraphCount).toBe(4);
      expect(result.html).toContain("<pre data-para-id");
      expect(result.html).toContain("<blockquote data-para-id");
    });

    it("marks figure and table elements", () => {
      const html = `
        <p>Before image</p>
        <figure><img src="test.jpg" alt="Test"><figcaption>Caption</figcaption></figure>
        <table><tr><td>Cell</td></tr></table>
        <p>After table</p>
      `;
      const result = addParagraphIdsToHtml(html);

      expect(result.paragraphCount).toBe(4);
      expect(result.html).toContain("<figure data-para-id");
      expect(result.html).toContain("<table data-para-id");
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
      const result = addParagraphIdsToHtml(html);

      expect(result.paragraphCount).toBe(6);

      // Verify order by checking substrings
      const h1Index = result.html.indexOf('<h1 data-para-id="para-0"');
      const firstPIndex = result.html.indexOf('<p data-para-id="para-1"');
      const h2Index = result.html.indexOf('<h2 data-para-id="para-2"');
      const blockquoteIndex = result.html.indexOf('<blockquote data-para-id="para-3"');
      const preIndex = result.html.indexOf('<pre data-para-id="para-4"');
      const lastPIndex = result.html.indexOf('<p data-para-id="para-5"');

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
      const result = addParagraphIdsToHtml(html);

      // ul and 3 li elements = 4 total
      expect(result.paragraphCount).toBe(4);
      expect(result.html).toContain("<ul data-para-id");
      expect(result.html).toContain("<li data-para-id");
    });

    it("marks ol and li elements", () => {
      const html = `
        <ol>
          <li>First</li>
          <li>Second</li>
        </ol>
      `;
      const result = addParagraphIdsToHtml(html);

      // ol and 2 li elements = 3 total
      expect(result.paragraphCount).toBe(3);
      expect(result.html).toContain("<ol data-para-id");
      expect(result.html).toContain("<li data-para-id");
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
      const result = addParagraphIdsToHtml(html);

      // Outer ul + parent li + inner ul + 2 child li + parent li = 6 total
      expect(result.paragraphCount).toBe(6);
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
      const result = addParagraphIdsToHtml(html);

      // p, ul, li, li, p = 5 elements
      expect(result.paragraphCount).toBe(5);

      // Verify p comes before ul in the output
      const pIndex = result.html.indexOf('<p data-para-id="para-0"');
      const ulIndex = result.html.indexOf('<ul data-para-id="para-1"');
      expect(pIndex).toBeLessThan(ulIndex);
    });
  });

  describe("empty content", () => {
    it("handles empty string", () => {
      const result = addParagraphIdsToHtml("");

      expect(result.html).toBe("");
      expect(result.paragraphCount).toBe(0);
    });

    it("handles whitespace-only string", () => {
      const result = addParagraphIdsToHtml("   \n\t  ");

      expect(result.html).toBe("");
      expect(result.paragraphCount).toBe(0);
    });

    it("handles HTML with no block elements", () => {
      const html = "<span>Inline text</span><a href='#'>Link</a>";
      const result = addParagraphIdsToHtml(html);

      expect(result.paragraphCount).toBe(0);
      expect(result.html).toContain("Inline text");
      expect(result.html).toContain("Link");
    });

    it("handles empty paragraph elements", () => {
      const html = "<p></p><p>Has content</p><p></p>";
      const result = addParagraphIdsToHtml(html);

      // Empty paragraphs still get IDs
      expect(result.paragraphCount).toBe(3);
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
      const result = addParagraphIdsToHtml(html);

      expect(result.paragraphCount).toBe(1);
      expect(result.html).toContain('data-para-id="para-0"');
    });

    it("handles inline elements within block elements", () => {
      const html = `
        <p>Text with <a href="#">link</a> and <code>code</code>.</p>
      `;
      const result = addParagraphIdsToHtml(html);

      expect(result.paragraphCount).toBe(1);
      expect(result.html).toContain("<a href=");
      expect(result.html).toContain("<code>");
    });

    it("handles self-closing elements", () => {
      const html = `
        <p>Before</p>
        <figure><img src="test.jpg" /></figure>
        <p>After</p>
      `;
      const result = addParagraphIdsToHtml(html);

      expect(result.paragraphCount).toBe(3);
    });

    it("handles HTML entities", () => {
      const html = "<p>Less &lt; than &amp; greater &gt; than</p>";
      const result = addParagraphIdsToHtml(html);

      expect(result.paragraphCount).toBe(1);
      // DOMParser may decode entities, that's fine
      expect(result.html).toContain("data-para-id");
    });

    it("handles special characters in content", () => {
      const html = "<p>Hello \"world\" with 'quotes' and unicode: </p>";
      const result = addParagraphIdsToHtml(html);

      expect(result.paragraphCount).toBe(1);
      expect(result.html).toContain("Hello");
    });

    it("handles multiple adjacent block elements without whitespace", () => {
      const html = "<p>One</p><p>Two</p><h2>Three</h2>";
      const result = addParagraphIdsToHtml(html);

      expect(result.paragraphCount).toBe(3);
    });

    it("does not mark non-block elements", () => {
      const html = `
        <p>Paragraph</p>
        <div>Not a block element for narration</div>
        <span>Also not marked</span>
        <section>Section not marked</section>
        <article>Article not marked</article>
      `;
      const result = addParagraphIdsToHtml(html);

      // Only p should be marked
      expect(result.paragraphCount).toBe(1);
      expect(result.html).not.toContain("<div data-para-id");
      expect(result.html).not.toContain("<span data-para-id");
      expect(result.html).not.toContain("<section data-para-id");
      expect(result.html).not.toContain("<article data-para-id");
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
      const result = addParagraphIdsToHtml(html);

      // Count: h1 + p + h2 + p + pre + h2 + p + blockquote + p + h2 + ul + 3*li + p = 15
      expect(result.paragraphCount).toBe(15);

      // Verify structure is preserved
      expect(result.html).toContain("<h1 data-para-id");
      expect(result.html).toContain("<h2 data-para-id");
      expect(result.html).toContain("<pre data-para-id");
      expect(result.html).toContain("<blockquote data-para-id");
      expect(result.html).toContain("<ul data-para-id");
      expect(result.html).toContain("<li data-para-id");
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
      const result = addParagraphIdsToHtml(html);

      // p + pre + p + blockquote + p + p = 6
      expect(result.paragraphCount).toBe(6);

      // Code content should be preserved
      expect(result.html).toContain("await fetchData()");
      expect(result.html).toContain("console.log");
    });
  });

  describe("consistency with server-side processing", () => {
    it("uses the same block elements as server-side", () => {
      // This test ensures client-side processing matches server-side
      const expectedElements = [
        "p",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "pre",
        "ul",
        "ol",
        "li",
        "figure",
        "table",
        "img",
      ];

      expect(BLOCK_ELEMENTS).toEqual(expectedElements);
      expect(BLOCK_ELEMENTS.length).toBe(15);
    });

    it("produces same ID format as server-side (para-N)", () => {
      const html = "<p>Test</p><h2>Header</h2><p>More</p>";
      const result = addParagraphIdsToHtml(html);

      expect(result.html).toContain('data-para-id="para-0"');
      expect(result.html).toContain('data-para-id="para-1"');
      expect(result.html).toContain('data-para-id="para-2"');
    });
  });
});

describe("processHtmlForHighlighting", () => {
  it("returns processed HTML string", () => {
    const html = "<p>Test paragraph</p>";
    const result = processHtmlForHighlighting(html);

    expect(typeof result).toBe("string");
    expect(result).toContain('data-para-id="para-0"');
  });

  it("returns empty string for empty input", () => {
    expect(processHtmlForHighlighting("")).toBe("");
    expect(processHtmlForHighlighting("   ")).toBe("");
  });

  it("can be used directly in a component", () => {
    // Simulate typical React usage
    const content = "<p>Article content</p>";
    const processed = processHtmlForHighlighting(content);

    expect(processed).toContain("data-para-id");
    expect(processed).toContain("Article content");
  });
});

describe("createMemoizedAddParagraphIds", () => {
  it("caches results for repeated calls", () => {
    const memoized = createMemoizedAddParagraphIds(5);
    const html = "<p>Test</p>";

    const result1 = memoized(html);
    const result2 = memoized(html);

    // Should return exact same object reference
    expect(result1).toBe(result2);
  });

  it("produces correct results", () => {
    const memoized = createMemoizedAddParagraphIds();
    const html = "<p>First</p><p>Second</p>";

    const result = memoized(html);

    expect(result.paragraphCount).toBe(2);
    expect(result.html).toContain('data-para-id="para-0"');
    expect(result.html).toContain('data-para-id="para-1"');
  });

  it("respects cache size limit", () => {
    const memoized = createMemoizedAddParagraphIds(2);

    // Add 3 entries, exceeding cache size of 2
    const result1 = memoized("<p>First</p>");
    const result2 = memoized("<p>Second</p>");
    const result3 = memoized("<p>Third</p>");

    // All should produce correct results
    expect(result1.paragraphCount).toBe(1);
    expect(result2.paragraphCount).toBe(1);
    expect(result3.paragraphCount).toBe(1);

    // First entry should have been evicted
    const result1Again = memoized("<p>First</p>");
    expect(result1Again).not.toBe(result1); // Different object reference (recomputed)
    expect(result1Again.paragraphCount).toBe(1); // But same content
  });

  it("handles empty input with caching", () => {
    const memoized = createMemoizedAddParagraphIds();

    const result1 = memoized("");
    const result2 = memoized("");

    expect(result1).toBe(result2);
    expect(result1.html).toBe("");
    expect(result1.paragraphCount).toBe(0);
  });

  it("caches different inputs separately", () => {
    const memoized = createMemoizedAddParagraphIds(10);

    const html1 = "<p>First</p>";
    const html2 = "<p>Second</p>";

    const result1 = memoized(html1);
    const result2 = memoized(html2);

    expect(result1).not.toBe(result2);
    expect(result1.html).toContain("First");
    expect(result2.html).toContain("Second");

    // Both should still be cached
    expect(memoized(html1)).toBe(result1);
    expect(memoized(html2)).toBe(result2);
  });
});

describe("BLOCK_ELEMENTS constant", () => {
  it("contains expected elements", () => {
    expect(BLOCK_ELEMENTS).toContain("p");
    expect(BLOCK_ELEMENTS).toContain("h1");
    expect(BLOCK_ELEMENTS).toContain("h2");
    expect(BLOCK_ELEMENTS).toContain("h3");
    expect(BLOCK_ELEMENTS).toContain("h4");
    expect(BLOCK_ELEMENTS).toContain("h5");
    expect(BLOCK_ELEMENTS).toContain("h6");
    expect(BLOCK_ELEMENTS).toContain("blockquote");
    expect(BLOCK_ELEMENTS).toContain("pre");
    expect(BLOCK_ELEMENTS).toContain("ul");
    expect(BLOCK_ELEMENTS).toContain("ol");
    expect(BLOCK_ELEMENTS).toContain("li");
    expect(BLOCK_ELEMENTS).toContain("figure");
    expect(BLOCK_ELEMENTS).toContain("table");
  });

  it("has exactly 15 elements", () => {
    expect(BLOCK_ELEMENTS.length).toBe(15);
  });
});

describe("htmlToClientNarration", () => {
  describe("basic functionality", () => {
    it("processes simple paragraphs", () => {
      const html = "<p>Hello world</p><p>Goodbye world</p>";
      const result = htmlToClientNarration(html);

      expect(result.narrationText).toBe("Hello world\n\nGoodbye world");
      expect(result.paragraphMap).toEqual([
        { n: 0, o: 0 },
        { n: 1, o: 1 },
      ]);
      expect(result.processedHtml).toContain('data-para-id="para-0"');
      expect(result.processedHtml).toContain('data-para-id="para-1"');
    });

    it("handles empty input", () => {
      const result = htmlToClientNarration("");

      expect(result.narrationText).toBe("");
      expect(result.paragraphMap).toEqual([]);
      expect(result.processedHtml).toBe("");
    });

    it("handles whitespace-only input", () => {
      const result = htmlToClientNarration("   \n\t  ");

      expect(result.narrationText).toBe("");
      expect(result.paragraphMap).toEqual([]);
      expect(result.processedHtml).toBe("");
    });
  });

  describe("image handling", () => {
    it("includes image with alt text in narration", () => {
      const html = '<p>Before</p><img src="test.jpg" alt="A photo of a cat"><p>After</p>';
      const result = htmlToClientNarration(html);

      expect(result.narrationText).toBe("Before\n\nImage: A photo of a cat\n\nAfter");
      expect(result.paragraphMap).toEqual([
        { n: 0, o: 0 },
        { n: 1, o: 1 },
        { n: 2, o: 2 },
      ]);
    });

    it("skips image without alt text (no narration, but still gets ID)", () => {
      const html = '<p>Before</p><img src="test.jpg"><p>After</p>';
      const result = htmlToClientNarration(html);

      // Image without alt text produces no narration text, so it's skipped in narrationText
      // but still gets a data-para-id in the DOM
      expect(result.narrationText).toBe("Before\n\nAfter");
      // para-0 is p "Before", para-1 is img (skipped in narration), para-2 is p "After"
      // So narration paragraph 0 maps to DOM element 0, narration paragraph 1 maps to DOM element 2
      expect(result.paragraphMap).toEqual([
        { n: 0, o: 0 },
        { n: 1, o: 2 },
      ]);
      // But the image still gets its ID in the DOM
      expect(result.processedHtml).toContain('data-para-id="para-1"');
    });

    it("skips image with empty alt text", () => {
      const html = '<p>Before</p><img src="test.jpg" alt=""><p>After</p>';
      const result = htmlToClientNarration(html);

      expect(result.narrationText).toBe("Before\n\nAfter");
      // Same mapping as above - image is skipped in narration
      expect(result.paragraphMap).toEqual([
        { n: 0, o: 0 },
        { n: 1, o: 2 },
      ]);
    });

    it("handles figure with image and figcaption", () => {
      const html = '<figure><img src="test.jpg"><figcaption>A cat photo</figcaption></figure>';
      const result = htmlToClientNarration(html);

      expect(result.narrationText).toBe("Image: A cat photo");
      expect(result.paragraphMap).toEqual([{ n: 0, o: 0 }]);
    });

    it("handles figure with image alt text", () => {
      const html = '<figure><img src="test.jpg" alt="Cat sitting on couch"></figure>';
      const result = htmlToClientNarration(html);

      expect(result.narrationText).toBe("Image: Cat sitting on couch");
    });

    it("includes inline image alt text within paragraphs", () => {
      const html = '<p>Some text <img src="test.jpg" alt="a cute cat"> more text</p>';
      const result = htmlToClientNarration(html);

      expect(result.narrationText).toBe("Some text Image: a cute cat more text");
      expect(result.paragraphMap).toEqual([{ n: 0, o: 0 }]);
    });

    it("handles multiple inline images within a paragraph", () => {
      const html = '<p>First <img alt="image one"> middle <img alt="image two"> last</p>';
      const result = htmlToClientNarration(html);

      expect(result.narrationText).toBe("First Image: image one middle Image: image two last");
    });

    it("skips inline images without alt text within paragraphs", () => {
      const html = '<p>Text before <img src="test.jpg"> text after</p>';
      const result = htmlToClientNarration(html);

      expect(result.narrationText).toBe("Text before  text after");
    });

    it("handles inline images in list items", () => {
      const html = '<ul><li>Item with <img alt="icon"> image</li></ul>';
      const result = htmlToClientNarration(html);

      // ul produces no text, li does
      expect(result.narrationText).toBe("Item with Image: icon image");
    });

    it("handles inline images in blockquotes", () => {
      const html = '<blockquote>Quote with <img alt="emphasis"> for effect</blockquote>';
      const result = htmlToClientNarration(html);

      expect(result.narrationText).toBe("Quote with Image: emphasis for effect");
    });
  });

  describe("code and pre elements", () => {
    it("skips code blocks in narration", () => {
      const html = "<p>Before</p><pre><code>const x = 1;</code></pre><p>After</p>";
      const result = htmlToClientNarration(html);

      // Code blocks produce no narration text
      expect(result.narrationText).toBe("Before\n\nAfter");
      // para-0 is p, para-1 is pre (skipped), para-2 is p
      expect(result.paragraphMap).toEqual([
        { n: 0, o: 0 },
        { n: 1, o: 2 },
      ]);
    });
  });

  describe("list handling", () => {
    it("handles ul/ol without narration text for container", () => {
      const html = "<ul><li>Item 1</li><li>Item 2</li></ul>";
      const result = htmlToClientNarration(html);

      // ul has no text, but li elements do
      expect(result.narrationText).toBe("Item 1\n\nItem 2");
      // ul is para-0 (skipped), li are para-1 and para-2
      expect(result.paragraphMap).toEqual([
        { n: 0, o: 1 },
        { n: 1, o: 2 },
      ]);
    });
  });

  describe("heading handling", () => {
    it("includes headings in narration", () => {
      const html = "<h1>Main Title</h1><p>Content</p><h2>Section</h2>";
      const result = htmlToClientNarration(html);

      expect(result.narrationText).toBe("Main Title\n\nContent\n\nSection");
      expect(result.paragraphMap).toEqual([
        { n: 0, o: 0 },
        { n: 1, o: 1 },
        { n: 2, o: 2 },
      ]);
    });
  });

  describe("paragraph mapping consistency", () => {
    it("ensures processed HTML IDs match paragraph map", () => {
      const html = "<p>First</p><p>Second</p><p>Third</p>";
      const result = htmlToClientNarration(html);

      // Parse the processed HTML and check IDs
      const parser = new DOMParser();
      const doc = parser.parseFromString(`<div>${result.processedHtml}</div>`, "text/html");
      const container = doc.body.firstElementChild!;

      const elements = container.querySelectorAll("[data-para-id]");
      expect(elements.length).toBe(3);
      expect(elements[0].getAttribute("data-para-id")).toBe("para-0");
      expect(elements[1].getAttribute("data-para-id")).toBe("para-1");
      expect(elements[2].getAttribute("data-para-id")).toBe("para-2");

      // Verify paragraph map correctly maps narration indices to element indices
      for (const mapping of result.paragraphMap) {
        const targetId = `para-${mapping.o}`;
        const element = container.querySelector(`[data-para-id="${targetId}"]`);
        expect(element).not.toBeNull();
      }
    });

    it("correctly maps when elements are skipped in narration", () => {
      // This is the key test for the sync issue
      const html = '<p>Before image</p><img src="x"><p>After image</p>';
      const result = htmlToClientNarration(html);

      // Narration text should have 2 paragraphs (image without alt is skipped)
      const narrationParagraphs = result.narrationText.split("\n\n");
      expect(narrationParagraphs.length).toBe(2);
      expect(narrationParagraphs[0]).toBe("Before image");
      expect(narrationParagraphs[1]).toBe("After image");

      // Paragraph map should correctly point to DOM element indices
      expect(result.paragraphMap[0]).toEqual({ n: 0, o: 0 }); // "Before image" -> para-0
      expect(result.paragraphMap[1]).toEqual({ n: 1, o: 2 }); // "After image" -> para-2 (skipping para-1 which is the image)

      // Verify the processed HTML has all 3 elements with IDs
      expect(result.processedHtml).toContain('data-para-id="para-0"');
      expect(result.processedHtml).toContain('data-para-id="para-1"'); // Image still gets ID
      expect(result.processedHtml).toContain('data-para-id="para-2"');
    });
  });

  describe("blockquote handling", () => {
    it("includes blockquote text in narration", () => {
      const html = "<blockquote>A famous quote goes here.</blockquote>";
      const result = htmlToClientNarration(html);

      expect(result.narrationText).toBe("A famous quote goes here.");
      expect(result.paragraphMap).toEqual([{ n: 0, o: 0 }]);
    });
  });

  describe("table handling", () => {
    it("includes table content in narration", () => {
      const html = "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>";
      const result = htmlToClientNarration(html);

      expect(result.narrationText).toBe("A, B. C, D");
      expect(result.paragraphMap).toEqual([{ n: 0, o: 0 }]);
    });
  });
});
