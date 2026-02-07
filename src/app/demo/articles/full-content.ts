import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "full-content",
  subscriptionId: "reading-experience",
  type: "web",
  url: null,
  title: "Full Content Fetching",
  author: null,
  summary: "Read complete articles inside Lion Reader, even when feeds only provide excerpts.",
  publishedAt: new Date("2026-01-15T12:00:00Z"),
  starred: false,
  contentHtml: `
    <h2>Full Content Fetching</h2>

    <p>Many RSS feeds only provide excerpts or summaries, forcing you to leave your feed reader to read the full article in a web browser. This constant context switching breaks your reading flow and makes it harder to stay focused on what matters.</p>

    <p>Lion Reader solves this problem by fetching the full article content on demand. When a feed only includes a summary, you can fetch the complete article with a single button press. The full content appears right in your reading interface, keeping you focused and in the flow.</p>

    <h3>How It Works</h3>

    <p>Under the hood, Lion Reader uses <a href="https://github.com/mozilla/readability" target="_blank" rel="noopener noreferrer">Mozilla&rsquo;s Readability algorithm</a> &mdash; the same technology that powers Firefox Reader View &mdash; to extract clean article text from web pages. The algorithm intelligently identifies the main content while stripping away ads, navigation bars, and other distractions.</p>

    <p>You can enable automatic full-content fetching per subscription for feeds that consistently truncate their articles. Or use the manual toggle to switch between feed content and full content whenever you need it. The system preserves images, code blocks, formatting, and document structure so you get an authentic reading experience. If extraction fails for any reason, Lion Reader gracefully falls back to displaying the original feed content.</p>

    <p>For Markdown-formatted content, Lion Reader uses the marked library to convert Markdown to clean HTML, preserving code blocks, tables, and all standard Markdown formatting.</p>
  `,
};

export default article;
