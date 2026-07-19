import { describe, it, expect } from "vitest";
import { computeSavedArticleExcerpt } from "@/server/services/saved-excerpt";

describe("computeSavedArticleExcerpt", () => {
  it("prefers Markdown frontmatter summary above everything", () => {
    const excerpt = computeSavedArticleExcerpt({
      markdownResult: { summary: "Frontmatter wins" },
      cleaned: { excerpt: "Readability excerpt", textContent: "Body text" },
      pluginContent: { html: "<p>Plugin</p>" },
      html: "<p>Raw</p>",
    });
    expect(excerpt).toBe("Frontmatter wins");
  });

  it("uses Readability output when it ran, even for plugin content (arXiv ToC bug #1398)", () => {
    // Raw arXiv HTML opens with a table-of-contents nav; Readability strips it and
    // extracts the article body. Because Readability ran (cleaned is non-null), the
    // excerpt must come from the cleaned content, not the raw plugin HTML.
    const tocHtml =
      "<nav><ol><li>1 Introduction</li><li>2 Monitoring Frontier Reasoning Models</li>" +
      "<li>2.1 Catching Systemic Reward Hacking</li></ol></nav>";
    const excerpt = computeSavedArticleExcerpt({
      markdownResult: null,
      cleaned: {
        excerpt: "",
        textContent:
          "Bowen Baker, Joost Huizinga, Leo Gao. Mitigating reward hacking remains a key challenge.",
      },
      pluginContent: { html: tocHtml },
      html: tocHtml,
    });
    expect(excerpt).toBe(
      "Bowen Baker, Joost Huizinga, Leo Gao. Mitigating reward hacking remains a key challenge."
    );
    expect(excerpt).not.toContain("Introduction");
  });

  it("prefers the Readability excerpt when present, falling back to body text", () => {
    expect(
      computeSavedArticleExcerpt({
        markdownResult: null,
        cleaned: { excerpt: "A good article-specific excerpt.", textContent: "Body text here." },
        pluginContent: null,
        html: "<p>Raw</p>",
      })
    ).toBe("A good article-specific excerpt.");

    expect(
      computeSavedArticleExcerpt({
        markdownResult: null,
        cleaned: { excerpt: "", textContent: "The article begins here." },
        pluginContent: null,
        html: "<p>Raw</p>",
      })
    ).toBe("The article begins here.");
  });

  it("hard-truncates a long body-text fallback to <=300 chars (no ellipsis)", () => {
    const long = "word ".repeat(200); // 1000 chars
    const excerpt = computeSavedArticleExcerpt({
      markdownResult: null,
      cleaned: { excerpt: "", textContent: long },
      pluginContent: null,
      html: "",
    });
    expect(excerpt).not.toBeNull();
    expect(excerpt!.length).toBeLessThanOrEqual(300);
    expect(long.startsWith(excerpt!)).toBe(true);
  });

  it("truncates a long Readability excerpt to 297 chars + ellipsis", () => {
    const long = "x".repeat(500);
    const excerpt = computeSavedArticleExcerpt({
      markdownResult: null,
      cleaned: { excerpt: long, textContent: "body" },
      pluginContent: null,
      html: "",
    });
    expect(excerpt).toBe("x".repeat(297) + "...");
  });

  it("summarizes raw plugin HTML only when Readability was skipped (cleaned is null)", () => {
    // e.g. Google Docs sets skipReadability: true, so no cleaned content exists.
    const excerpt = computeSavedArticleExcerpt({
      markdownResult: null,
      cleaned: null,
      pluginContent: { html: "<p>Google Doc body content.</p>" },
      html: "<p>ignored</p>",
    });
    expect(excerpt).toBe("Google Doc body content.");
  });

  it("summarizes raw Markdown HTML when there is no frontmatter summary and no cleaned content", () => {
    const excerpt = computeSavedArticleExcerpt({
      markdownResult: { summary: null },
      cleaned: null,
      pluginContent: null,
      html: "<h1>Title</h1><p>Markdown body.</p>",
    });
    expect(excerpt).toBe("Title Markdown body.");
  });

  it("returns null when nothing usable is available (Readability failed on a plain page)", () => {
    expect(
      computeSavedArticleExcerpt({
        markdownResult: null,
        cleaned: null,
        pluginContent: null,
        html: "<p>Raw page that Readability rejected.</p>",
      })
    ).toBeNull();
  });
});
