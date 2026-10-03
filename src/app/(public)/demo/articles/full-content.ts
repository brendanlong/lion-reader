import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "full-content",
  subscriptionId: "reading-experience",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/287",
  title: "Full Articles from Excerpt-Only Feeds",
  author: null,
  summary:
    "When a feed only sends a teaser, Lion Reader fetches the whole article so you can keep reading without leaving the app.",
  publishedAt: new Date("2026-01-15T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader fetches full article content on demand using Mozilla&#39;s Readability algorithm, eliminating the need to leave your reader. Enable automatic fetching per subscription or toggle manually to get clean, distraction-free articles with preserved formatting, images, and code blocks.</p>`,
  summaryModelId: "claude-sonnet-4-6",
  summaryGeneratedAt: new Date("2026-02-07"),
  contentHtml: `
    <p>Many feeds only include the first paragraph or two, so you have to leave your reader to finish the article. Lion Reader can fetch the complete article for you and show it right where you&rsquo;re reading &mdash; cleaned up, without the site&rsquo;s ads and navigation, but with its images, code, and formatting intact.</p>

    <p>Tap the full-content button on any article to switch between the feed&rsquo;s version and the full one. For feeds that always cut articles short, turn on full content for that subscription and every new article arrives complete.</p>

    <p>Once you have the full text, <a href="/demo/all?entry=ai-summaries">summaries</a> and <a href="/demo/all?entry=text-to-speech">narration</a> cover the whole article, not just the teaser.</p>
  `,
};

export default article;
