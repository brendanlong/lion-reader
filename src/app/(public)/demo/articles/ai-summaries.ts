import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "ai-summaries",
  subscriptionId: "reading-experience",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/298",
  title: "AI Summaries",
  author: null,
  summary:
    "Get a short summary of any article in a few seconds, so you can decide what's worth reading in full.",
  publishedAt: new Date("2026-01-16T12:00:00Z"),
  starred: true,
  summaryHtml: `<p>Press <strong>Summarize</strong> on any article to get a short overview of its main points before deciding whether to read it. Adjust length, instructions, or model in Settings, or connect your own AI provider account.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>A busy morning can leave you with dozens of unread articles. Which ones are worth your time? Press <strong>Summarize</strong> on any article and in a few seconds you get a short overview of its main points, right above the article. Read the summary, then decide whether to read the whole thing &mdash; or move on.</p>

    <p>Try it on any article in this demo. Each one has a summary ready to show you what it looks like.</p>

    <h3>Make It Yours</h3>

    <p>Prefer shorter summaries, bullet points, or a different focus? Set how long summaries should be, rewrite the instructions the AI follows, or pick a different AI model in Settings. If you pay for your own account with a supported AI provider, connect it to use its models.</p>

    <p>If a feed only sends a teaser, <a href="/demo/all?entry=full-content">fetch the full article</a> first and the summary covers the whole thing.</p>
  `,
};

export default article;
