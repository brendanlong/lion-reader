import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "full-content",
  subscriptionId: "reading-experience",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/287",
  title: "Full Articles, Not Teasers",
  author: null,
  summary:
    "When a feed only sends a teaser, Lion Reader can fetch the whole article so you can keep reading without leaving the app.",
  publishedAt: new Date("2026-01-15T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>When a feed sends only a teaser, pressing <strong>Full Content</strong> fetches the complete article, cleaned of ads and navigation but keeping images and formatting; the choice sticks so future posts from that subscription arrive complete. Paywalled articles still show only their public part, and summaries or listening cover it fully.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>Many sites put only the first paragraph or two in their feed, so you have to leave your reader to finish the article. Lion Reader can fetch the complete article for you and show it right where you&rsquo;re reading &mdash; cleaned up, without the site&rsquo;s ads and navigation, but with its images and formatting intact.</p>

    <p>Press <strong>Full Content</strong> on an article to load the complete version. The choice sticks for that subscription, so its new articles arrive complete from then on. Press it again to go back to the feed&rsquo;s version. Lion Reader fetches the page as anyone without a login would see it, so paywalled articles still show only their public part.</p>

    <p>Once you have the full text, <a href="/demo/all?entry=ai-summaries">summaries</a> and <a href="/demo/all?entry=text-to-speech">listening</a> cover the whole article, not just the teaser. <a href="/demo/all?entry=email-newsletters">Newsletters</a> and <a href="/demo/all?entry=save-for-later">saved articles</a> already arrive complete.</p>
  `,
};

export default article;
