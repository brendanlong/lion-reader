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

  it("delegates the cleaned branch to summarizeCleanedContent (description-preferred)", () => {
    // A substantial excerpt (>= 50 chars) wins over the body text...
    const excerpt = "A good, article-specific description that is clearly long enough.";
    expect(
      computeSavedArticleExcerpt({
        markdownResult: null,
        cleaned: { excerpt, textContent: "Body text here." },
        pluginContent: null,
        html: "<p>Raw</p>",
      })
    ).toBe(excerpt);

    // ...and the body text is used when there is no usable excerpt.
    expect(
      computeSavedArticleExcerpt({
        markdownResult: null,
        cleaned: { excerpt: "", textContent: "The article begins here." },
        pluginContent: null,
        html: "<p>Raw</p>",
      })
    ).toBe("The article begins here.");
  });

  it("returns null when the cleaned content is empty", () => {
    expect(
      computeSavedArticleExcerpt({
        markdownResult: null,
        cleaned: { excerpt: "", textContent: "" },
        pluginContent: null,
        html: "<p>Raw</p>",
      })
    ).toBeNull();
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
