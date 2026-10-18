/**
 * Unit tests for processArticleContent, the one pipeline that turns acquired
 * article content into the stored original/cleaned pair for saves, uploads and
 * full-content fetches.
 */

import { describe, it, expect } from "vitest";
import {
  processArticleContent,
  type ArticleContentBundle,
} from "../../src/server/services/article-content";

const BASE_URL = "https://example.com/posts/article";
const RELATIVE_BODY = '<p>Body <a href="other">link</a> <img src="img/fig.png"></p>';
const ABSOLUTE_LINK = 'href="https://example.com/posts/other"';
const ABSOLUTE_IMG = 'src="https://example.com/posts/img/fig.png"';

const ARTICLE_PAGE = `<html><head><title>Article</title></head><body>
  <nav><a href="/">Home</a> <a href="/about">About</a></nav>
  <article><h1>Article</h1>
    ${Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i} of a real article, long enough that Readability treats this block as the main content of the page and keeps it.</p>`).join("\n")}
    <p><img src="img/fig.png"></p>
  </article>
</body></html>`;

function bundle(overrides: Partial<ArticleContentBundle>): ArticleContentBundle {
  return {
    html: RELATIVE_BODY,
    contentUrl: BASE_URL,
    pluginContent: null,
    preCleanedContent: null,
    ...overrides,
  };
}

describe("processArticleContent", () => {
  it.each([
    [
      "plugin content that skips Readability",
      bundle({ pluginContent: { html: RELATIVE_BODY, skipReadability: true } }),
    ],
    // Too short for Readability to extract, so it falls back to the plugin body.
    [
      "plugin content Readability can't extract",
      bundle({ pluginContent: { html: RELATIVE_BODY } }),
    ],
    [
      "pre-cleaned content",
      bundle({ preCleanedContent: { title: null, summary: null, author: null } }),
    ],
  ])("stores %s, absolutized, as both copies", async (_label, input) => {
    const result = await processArticleContent(input, BASE_URL, { offload: false });

    expect(result.contentOriginal).toContain(ABSOLUTE_LINK);
    expect(result.contentOriginal).toContain(ABSOLUTE_IMG);
    expect(result.contentCleaned).toBe(result.contentOriginal);
    expect(result.readability).toBeNull();
  });

  it("leaves cleaned null when Readability fails on a generic page", async () => {
    const result = await processArticleContent(bundle({}), BASE_URL, { offload: false });

    expect(result.contentCleaned).toBeNull();
    expect(result.contentOriginal).toContain(ABSOLUTE_IMG);
  });

  it("stores Readability's extraction as cleaned and the absolutized page as original", async () => {
    const result = await processArticleContent(bundle({ html: ARTICLE_PAGE }), BASE_URL, {
      offload: true,
    });

    expect(result.readability?.content).toBe(result.contentCleaned);
    expect(result.contentCleaned).toContain("Paragraph 5");
    expect(result.contentCleaned).not.toContain("About");
    expect(result.contentOriginal).toContain('href="https://example.com/about"');
    expect(result.contentOriginal).toContain(ABSOLUTE_IMG);
  });
});
