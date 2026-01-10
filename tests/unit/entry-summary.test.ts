import { describe, it, expect } from "vitest";
import { stripHtml } from "@/server/html/strip-html";

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
  });

  describe("HTML entity decoding", () => {
    it("decodes common HTML entities", () => {
      const html = "<p>Rock &amp; Roll</p>";
      expect(stripHtml(html, 300)).toBe("Rock & Roll");
    });

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
    it("does not truncate text within limit", () => {
      const html = "<p>Short text</p>";
      expect(stripHtml(html, 300)).toBe("Short text");
    });

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

    it("handles real-world summary case", () => {
      const html = `
        <h1>The problem of evaluation awareness</h1>
        <p>I've taken on the task of making highly realistic alignment evaluations,
        and I'm now sure that the mainstream approach of creating such evals is a
        dead end and should change.</p>
      `;
      const result = stripHtml(html, 300);
      expect(result).toContain("The problem of evaluation awareness");
      expect(result).toContain("I've taken on");
      // Should have space between heading and paragraph
      expect(result).not.toContain("awarenessI've");
    });
  });

  describe("inline elements", () => {
    it("preserves text from inline elements without extra spacing", () => {
      const html = "<p>This is <strong>bold</strong> and <em>italic</em> text.</p>";
      expect(stripHtml(html, 300)).toBe("This is bold and italic text.");
    });

    it("handles links", () => {
      const html = '<p>Click <a href="http://example.com">here</a> to continue.</p>';
      expect(stripHtml(html, 300)).toBe("Click here to continue.");
    });

    it("handles spans", () => {
      const html = '<p>Some <span class="highlight">highlighted</span> text.</p>';
      expect(stripHtml(html, 300)).toBe("Some highlighted text.");
    });
  });
});
