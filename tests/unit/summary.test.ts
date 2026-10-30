import { describe, it, expect } from "vitest";
import {
  generateSummary,
  summarizeCleanedContent,
  SUMMARY_MAX_LENGTH,
} from "@/server/html/summary";

describe("generateSummary", () => {
  describe("labels and scaffolding", () => {
    it.each([
      ["a heading", "<h2>Summary</h2><p>An AI assistant might recommend it.</p>"],
      [
        "a table caption",
        "<table><caption>Table 1: Results</caption></table><p>An AI assistant might recommend it.</p>",
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

    it("keeps body text laid out in header cells (Foundation for Emails)", () => {
      const html =
        '<table class="row"><tr><th class="columns"><p>This week in the newsletter.</p></th></tr></table><table><tr><td><p>Unsubscribe</p></td></tr></table>';
      expect(generateSummary(html)).toBe("This week in the newsletter. Unsubscribe");
    });

    it("keeps headings when there is no other text", () => {
      expect(generateSummary("<h1>Only a title</h1><h2>And a subtitle</h2>")).toBe(
        "Only a title And a subtitle"
      );
    });
  });

  describe("footnote markers", () => {
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
      [
        "nested MathML fractions",
        "<p><math><mfrac><mi>a</mi><mfrac><mi>b</mi><mi>c</mi></mfrac></mfrac> and <mfrac><mfrac><mi>a</mi><mi>b</mi></mfrac><mi>c</mi></mfrac></math></p>",
        "a/(b/c) and (a/b)/c",
      ],
    ])("transliterates %s", (_, html, expected) => {
      expect(generateSummary(html)).toBe(expected);
    });

    it("adds no fraction slash for MathML in a hidden annotation", () => {
      const html =
        '<p>Value <math><semantics><mi>x</mi><annotation-xml encoding="MathML-Presentation"><mfrac><mi>a</mi><mi>b</mi></mfrac></annotation-xml></semantics></math> here.</p>';
      expect(generateSummary(html)).toBe("Value x here.");
    });

    it("leaves nested scripts as plain text rather than one exponent", () => {
      expect(generateSummary("<p>10<sup>2<sup>3</sup></sup></p>")).toBe("1023");
    });

    it("leaves a script with no Unicode form as plain text", () => {
      expect(generateSummary("<p>The 19<sup>th</sup> century, e<sup>x+y</sup></p>")).toBe(
        "The 19th century, ex+y"
      );
    });
  });

  describe("length", () => {
    it("cuts long text at a word boundary with an ellipsis", () => {
      const summary = generateSummary(`<p>${"word ".repeat(SUMMARY_MAX_LENGTH)}</p>`);
      expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX_LENGTH);
      expect(summary.endsWith(" word...")).toBe(true);
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
