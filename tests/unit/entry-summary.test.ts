import { describe, it, expect } from "vitest";
import {
  generateSummary,
  stripHtml,
  summarizeCleanedContent,
  SUMMARY_MAX_LENGTH,
} from "@/server/html/strip-html";
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

describe("generateSummary", () => {
  describe("labels and scaffolding", () => {
    it.each([
      ["a heading", "<h2>Summary</h2><p>An AI assistant might recommend it.</p>"],
      [
        "table headers and captions",
        "<table><caption>Table 1</caption><tr><th>Type</th></tr></table><p>An AI assistant might recommend it.</p>",
      ],
      [
        "a fraction inside a heading",
        "<h1>Ratio <math><mfrac><mi>a</mi><mi>b</mi></mfrac></math></h1><p>An AI assistant might recommend it.</p>",
      ],
      [
        "a figure caption",
        "<figure><img src=x.png><figcaption>Figure 1: A chart</figcaption></figure><p>An AI assistant might recommend it.</p>",
      ],
    ])("skips %s so it doesn't run into the prose", (_, html) => {
      expect(generateSummary(html)).toBe("An AI assistant might recommend it.");
    });

    it("keeps body text laid out in tables (emails)", () => {
      const html =
        '<table role="presentation"><tr><td><p>This week in the newsletter.</p></td></tr></table><p>Unsubscribe</p>';
      expect(generateSummary(html)).toBe("This week in the newsletter. Unsubscribe");
    });

    it("keeps headings when there is no other text", () => {
      expect(generateSummary("<h1>Only a title</h1><h2>And a subtitle</h2>")).toBe(
        "Only a title And a subtitle"
      );
    });
  });

  describe("footnote markers and comment links", () => {
    it.each([
      ["LessWrong/Pandoc (link inside sup)", '<sup><a href="#fn1">[1]</a></sup>'],
      [
        "WordPress (sup inside link)",
        '<a class="sdfootnoteanc" href="#sdfootnote1sym"><sup>1</sup></a>',
      ],
      ["a symbol marker", '<a href="#note">*</a>'],
    ])("drops %s", (_, marker) => {
      expect(generateSummary(`<p>Like most monarchs,${marker} Philippe reigns.</p>`)).toBe(
        "Like most monarchs, Philippe reigns."
      );
    });

    it("keeps in-page links with real text", () => {
      expect(generateSummary('<p>See <a href="#methods">the methods</a> below.</p>')).toBe(
        "See the methods below."
      );
    });

    it("keeps bare-number section links", () => {
      const html = '<p>See sections <a href="#s1">1</a> and <a href="#s2">2</a>.</p>';
      expect(generateSummary(html)).toBe("See sections 1 and 2.");
    });

    it("drops a bare-number note reference marked up without a superscript", () => {
      const html =
        '<p>Like most monarchs,<a href="#fn1" role="doc-noteref">1</a> Philippe reigns.</p>';
      expect(generateSummary(html)).toBe("Like most monarchs, Philippe reigns.");
    });

    it("keeps numbered links to other pages", () => {
      expect(generateSummary('<p>Part <a href="https://example.com/2">2</a> is out.</p>')).toBe(
        "Part 2 is out."
      );
    });

    it("drops a trailing link to the comments", () => {
      const html =
        '<p>Is anyone working on this?</p><br/><br/><a href="https://www.lesswrong.com/posts/abc/x#comments">Discuss</a>';
      expect(generateSummary(html)).toBe("Is anyone working on this?");
    });

    it("keeps a comments link that text follows", () => {
      const html =
        '<p>As argued in <a href="https://other.com/post#comments">this thread</a>, we disagree.</p>';
      expect(generateSummary(html)).toBe("As argued in this thread, we disagree.");
    });

    it("keeps the article when a comments link is never closed", () => {
      const html = '<a href="https://x.com/p#comments">3 comments<p>A short update.</p>';
      expect(generateSummary(html)).toBe("3 comments A short update.");
    });

    it("keeps a comments link that ends a sentence", () => {
      const html = '<p>Finish with <a href="https://x.com/p#comments">the discussion.</a></p>';
      expect(generateSummary(html)).toBe("Finish with the discussion.");
    });
  });

  describe("WordPress feed footer", () => {
    it("drops the footer paragraph", () => {
      const html =
        '<p>New to the comic? Catch up here.</p><p>The post <a href="https://x.com/1">DC Minis #33</a> appeared first on <a href="https://x.com">Dresden Codak</a>.</p>';
      expect(generateSummary(html)).toBe("New to the comic? Catch up here.");
    });

    it("drops the footer when it straddles the summary length", () => {
      const excerpt = "word ".repeat(SUMMARY_MAX_LENGTH / 5 - 10).trim();
      const html = `<p>${excerpt}</p><p>The post <a href="https://x.com/1">A Title</a> appeared first on <a href="https://x.com">Example Engineering</a>.</p>`;
      expect(generateSummary(html)).toBe(excerpt);
    });

    it("keeps a paragraph that merely mentions the phrase", () => {
      const html = "<p>Then I wrote: The post appeared first on my blog. Nobody noticed.</p>";
      expect(generateSummary(html)).toBe(
        "Then I wrote: The post appeared first on my blog. Nobody noticed."
      );
    });
  });

  describe("super- and subscripts", () => {
    it.each([
      ["HTML superscript", "<p>E=mc<sup>2</sup> and 10<sup>-3</sup></p>", "E=mc² and 10⁻³"],
      ["HTML subscript", "<p>H<sub>2</sub>O</p>", "H₂O"],
      ["MathML msup", "<p><math><mi>c</mi><msup><mi>x</mi><mn>2</mn></msup></math></p>", "cx²"],
      [
        "MathML msubsup",
        "<p><math><msubsup><mi>x</mi><mn>1</mn><mn>2</mn></msubsup></math></p>",
        "x₁²",
      ],
      ["MathML mfrac", "<p><math><mfrac><mi>a</mi><mi>b</mi></mfrac></math></p>", "a/b"],
      [
        "MathML mfrac with a composite operand",
        "<p>f(x)=<math><mfrac><mn>1</mn><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow></mfrac></math>.</p>",
        "f(x)=1/(x+1).",
      ],
    ])("transliterates %s", (_, html, expected) => {
      expect(generateSummary(html)).toBe(expected);
    });

    it("leaves a script with no Unicode form as plain text", () => {
      expect(generateSummary("<p>The 19<sup>th</sup> century, e<sup>x+y</sup></p>")).toBe(
        "The 19th century, ex+y"
      );
    });
  });

  describe("image-only content", () => {
    it("falls back to the image's alt text", () => {
      const html =
        '<img src="https://imgs.xkcd.com/comics/fusion_device.png" alt="I don\'t see why people have trouble doing this." />';
      expect(generateSummary(html)).toBe("I don't see why people have trouble doing this.");
    });

    it.each([
      ["a URL", "https://www.oglaf.com/serpent-princess/"],
      ["a filename", "comic-2026-10-18.png"],
    ])("ignores alt text that is %s", (_, alt) => {
      expect(generateSummary(`<a href="/"><img src="a.jpg" alt="${alt}"></a>`)).toBe("");
    });

    it("picks the longest alt, which describes the main image rather than a nav button", () => {
      const html =
        '<a href="/next"><img src="next.png" alt="Next Page"></a><img src="comic.jpg" alt="Dark Science #191 - The Prince">';
      expect(generateSummary(html)).toBe("Dark Science #191 - The Prince");
    });

    it("prefers any prose over alt text", () => {
      expect(
        generateSummary('<img src="a.png" alt="A chart of tax revenue"><p>Taxes rose.</p>')
      ).toBe("Taxes rose.");
    });
  });
});

describe("summarizeCleanedContent", () => {
  it("uses the excerpt when it is substantial (>= 50 chars)", () => {
    const excerpt = "This is a meaningful excerpt that summarizes the article content well.";
    expect(summarizeCleanedContent({ excerpt, content: "<p>Full body text here.</p>" })).toBe(
      excerpt
    );
  });

  it("summarizes the article HTML when the excerpt is too short", () => {
    const summary = summarizeCleanedContent({
      excerpt: "Too short",
      content: "<h2>Abstract</h2><p>The article begins here.</p>",
    });
    expect(summary).toBe("The article begins here.");
  });

  it("returns an empty string for empty content", () => {
    expect(summarizeCleanedContent({ excerpt: "", content: "" })).toBe("");
  });
});
