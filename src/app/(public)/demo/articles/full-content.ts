import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "full-content",
  subscriptionId: "reading-experience",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/287",
  title: "Full Articles from Excerpt-Only Feeds",
  author: null,
  summary:
    "When a feed only sends a teaser, Lion Reader can fetch the whole article so you can keep reading without leaving the app.",
  publishedAt: new Date("2026-01-15T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Many feeds only publish the first paragraph or two of an article. Lion Reader can fetch the <strong>complete article</strong>, cleaned of ads, right where you&rsquo;re reading &mdash; with images, code, and formatting intact. Turn it on from any article and it sticks for that subscription; summaries and narration cover the whole thing.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>Many feeds only include the first paragraph or two, so you have to leave your reader to finish the article. Lion Reader can fetch the complete article for you and show it right where you&rsquo;re reading &mdash; cleaned up, without the site&rsquo;s ads and navigation, but with its images, code, and formatting intact.</p>

    <p>Tap the full-content button on an article to load the complete version. The choice sticks for that subscription, so its new articles arrive complete from then on. Tap it again to go back to the feed&rsquo;s version.</p>

    <p>Once you have the full text, <a href="/demo/all?entry=ai-summaries">summaries</a> and <a href="/demo/all?entry=text-to-speech">narration</a> cover the whole article, not just the teaser.</p>
  `,
};

export default article;
