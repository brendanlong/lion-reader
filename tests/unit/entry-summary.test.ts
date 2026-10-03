import { describe, it, expect } from "vitest";
import { stripHtml, summarizeCleanedContent, SUMMARY_MAX_LENGTH } from "@/server/html/strip-html";
import { sanitizeEntryHtml } from "@/server/html/sanitize";

describe("stripHtml", () => {
  describe("basic text extraction", () => {
    it("extracts plain text from simple HTML", () => {
      const html = "<p>Hello world</p>";
      expect(stripHtml(html, 300)).toBe("Hello world");
    });

    it("returns empty string for empty input", () => {
      expect(stripHtml("", 300)).toBe("");
    });

    it("returns empty string for whitespace-only HTML", () => {
      expect(stripHtml("<p>   </p>", 300)).toBe("");
    });

    it("handles plain text without HTML tags", () => {
      const text = "Just some plain text";
      expect(stripHtml(text, 300)).toBe("Just some plain text");
    });
  });

  describe("spacing between block elements", () => {
    it("adds space between heading and paragraph", () => {
      const html = "<h1>The Title</h1><p>The content starts here.</p>";
      expect(stripHtml(html, 300)).toBe("The Title The content starts here.");
    });

    it("adds space between consecutive paragraphs", () => {
      const html = "<p>First paragraph.</p><p>Second paragraph.</p>";
      expect(stripHtml(html, 300)).toBe("First paragraph. Second paragraph.");
    });

    it("adds space after list items", () => {
      const html = "<ul><li>Item one</li><li>Item two</li></ul>";
      expect(stripHtml(html, 300)).toBe("Item one Item two");
    });

    it("handles br tags", () => {
      const html = "Line one<br>Line two<br/>Line three";
      expect(stripHtml(html, 300)).toBe("Line one Line two Line three");
    });

    it("handles hr tags", () => {
      const html = "<p>Before</p><hr><p>After</p>";
      expect(stripHtml(html, 300)).toBe("Before After");
    });

    it("handles deeply nested block elements", () => {
      const html = `
        <article>
          <header>
            <h1>Article Title</h1>
          </header>
          <section>
            <p>First paragraph.</p>
          </section>
        </article>
      `;
      expect(stripHtml(html, 300)).toBe("Article Title First paragraph.");
    });
  });

  describe("whitespace normalization", () => {
    it("collapses multiple spaces", () => {
      const html = "<p>Hello    world</p>";
      expect(stripHtml(html, 300)).toBe("Hello world");
    });

    it("collapses newlines and tabs", () => {
      const html = "<p>Hello\n\n\tworld</p>";
      expect(stripHtml(html, 300)).toBe("Hello world");
    });

    it("trims leading and trailing whitespace", () => {
      const html = "   <p>  Hello world  </p>   ";
      expect(stripHtml(html, 300)).toBe("Hello world");
    });

    it("does not add duplicate spaces between block elements", () => {
      const html = "<h1>Title</h1>   <p>Content</p>";
      expect(stripHtml(html, 300)).toBe("Title Content");
    });
  });

  describe("script and style exclusion", () => {
    it("excludes script content", () => {
      const html = '<p>Before</p><script>alert("bad")</script><p>After</p>';
      expect(stripHtml(html, 300)).toBe("Before After");
    });

    it("excludes style content", () => {
      const html = "<p>Before</p><style>.foo { color: red; }</style><p>After</p>";
      expect(stripHtml(html, 300)).toBe("Before After");
    });

    it("handles nested script tags correctly", () => {
      const html = "<p>A</p><script><script>nested</script></script><p>B</p>";
      expect(stripHtml(html, 300)).toBe("A B");
    });

    it("excludes head and title content from full HTML documents", () => {
      const html =
        "<!DOCTYPE html><html><head><title>Page Title</title></head><body><p>Body content here.</p></body></html>";
      expect(stripHtml(html, 300)).toBe("Body content here.");
    });
  });

  describe("raw-text elements", () => {
    // The HTML tokenizer reads these elements' contents as a single *text* run,
    // so `ontext` receives the inner markup verbatim. Skipping them is what
    // keeps an excerpt from reading "<p>Fallback <b>text</b></p>".
    it("drops iframe fallback content rather than leaking its markup", () => {
      const html =
        '<p>Before</p><iframe src="https://example.com/x"><p>Fallback <b>text</b></p></iframe><p>After</p>';
      expect(stripHtml(html, 300)).toBe("Before After");
    });

    it("drops everything after plaintext, which never closes", () => {
      const html = "<p>Visible</p><plaintext><p>Swallowed by the tokenizer</p>";
      expect(stripHtml(html, 300)).toBe("Visible");
    });

    it("drops textarea and option content (form defaults, not prose)", () => {
      const html =
        "<p>A</p><textarea>typed &amp; saved</textarea><select><option>Choice</option></select><p>B</p>";
      expect(stripHtml(html, 300)).toBe("A B");
    });

    it("keeps surrounding prose when a raw-text element is unclosed", () => {
      const html = '<p>Before</p><iframe src="x">fallback<p>After</p>';
      // The implied close lands at EOF, so nothing after it survives — but the
      // skip counter must not go negative and swallow the whole document.
      expect(stripHtml(html, 300)).toBe("Before");
    });
  });

  // The excerpt describes what the reader will see, so it must never surface
  // text the sanitizer removes before rendering. Both halves run for real
  // rather than being re-encoded here, so a regression on either side fails.
  // The list mirrors the sanitizer's DROP_WITH_CONTENT — extend both together.
  describe("agrees with the sanitizer about dropped subtrees (sync guard)", () => {
    const DROPPED_WITH_CONTENT = [
      "script",
      "style",
      "textarea",
      "option",
      "title",
      "xmp",
      "iframe",
      "noembed",
      "noframes",
      "noscript",
      "plaintext",
      "annotation",
      "annotation-xml",
    ];

    it.each(DROPPED_WITH_CONTENT)("%s content reaches neither surface", (tag) => {
      const html = `<p>Visible</p><${tag}>NOTFORREADERS</${tag}><p>Tail</p>`;

      expect(sanitizeEntryHtml(html)).not.toContain("NOTFORREADERS");
      expect(stripHtml(html, 300)).not.toContain("NOTFORREADERS");
    });
  });

  describe("MathML annotations", () => {
    // KaTeX (output: "mathml") emits presentation MathML *plus* an
    // <annotation encoding="application/x-tex"> holding the raw TeX. Without
    // dropping the annotation, the equation appears twice in the excerpt (#1386).
    it("drops the TeX annotation so the equation is not duplicated", () => {
      const html =
        "<p>The formula <math><semantics><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow>" +
        '<annotation encoding="application/x-tex">E = mc^2</annotation></semantics></math> is famous.</p>';
      const result = stripHtml(html, 300);
      expect(result).not.toContain("E = mc^2");
      expect(result).toBe("The formula E=mc2 is famous.");
    });

    it("drops annotation-xml content too", () => {
      const html =
        "<p>Value <math><semantics><mrow><mi>x</mi></mrow>" +
        '<annotation-xml encoding="MathML-Content"><ci>x</ci></annotation-xml></semantics></math> here.</p>';
      const result = stripHtml(html, 300);
      expect(result).toBe("Value x here.");
    });

    it("keeps presentation glyphs from feed math (no annotation)", () => {
      const html =
        "<p>Range <math><mrow><mi>μ</mi><mo>±</mo><mn>2</mn><mi>σ</mi></mrow></math> shown.</p>";
      expect(stripHtml(html, 300)).toBe("Range μ±2σ shown.");
    });
  });

  describe("HTML entity decoding", () => {
    it("decodes numeric entities", () => {
      const html = "<p>&#60;tag&#62;</p>";
      expect(stripHtml(html, 300)).toBe("<tag>");
    });

    it("decodes named entities", () => {
      const html = "<p>&quot;quoted&quot; &mdash; dashed</p>";
      expect(stripHtml(html, 300)).toBe('"quoted" — dashed');
    });
  });

  describe("truncation", () => {
    it("truncates at word boundary with ellipsis", () => {
      const html = "<p>This is a longer piece of text that needs truncating.</p>";
      const result = stripHtml(html, 30);
      expect(result).toBe("This is a longer piece of...");
      expect(result.length).toBeLessThanOrEqual(30);
    });

    it("truncates at exact limit when no space found", () => {
      const html = "<p>Supercalifragilisticexpialidocious</p>";
      const result = stripHtml(html, 20);
      expect(result).toBe("Supercalifragilis...");
      expect(result.length).toBe(20);
    });
  });

  describe("inline elements", () => {
    it("preserves text from inline elements without extra spacing", () => {
      const html = "<p>This is <strong>bold</strong> and <em>italic</em> text.</p>";
      expect(stripHtml(html, 300)).toBe("This is bold and italic text.");
    });

    it("adds space between inline element and following block element", () => {
      const html = "<a>X</a><p>Y</p>";
      expect(stripHtml(html, 300)).toBe("X Y");
    });
  });
});

describe("summarizeCleanedContent", () => {
  it("uses the excerpt when it is substantial (>= 50 chars)", () => {
    const excerpt = "This is a meaningful excerpt that summarizes the article content well.";
    expect(summarizeCleanedContent({ excerpt, textContent: "Full body text here." })).toBe(excerpt);
  });

  it("falls back to body text when the excerpt is too short", () => {
    const summary = summarizeCleanedContent({
      excerpt: "Too short",
      textContent: "This is the full text content that should be used for the summary.",
    });
    expect(summary).toContain("full text content");
  });

  it("falls back to body text when there is no excerpt", () => {
    expect(summarizeCleanedContent({ excerpt: "", textContent: "The article begins here." })).toBe(
      "The article begins here."
    );
  });

  it("truncates long content at a word boundary with an ellipsis", () => {
    // Well past the limit, with spaces to break on.
    const longText = "word ".repeat(SUMMARY_MAX_LENGTH).trim();
    const summary = summarizeCleanedContent({ excerpt: "", textContent: longText });
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX_LENGTH + "...".length);
    expect(summary.endsWith("...")).toBe(true);
    expect(summary.includes("wordword")).toBe(false); // broke on a space
  });

  it("returns an empty string for empty content", () => {
    expect(summarizeCleanedContent({ excerpt: "", textContent: "" })).toBe("");
  });
});
