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
  summaryHtml: `<p>Pressing <strong>Summarize</strong> on any article shows a short overview of its main points above it within seconds, so you can decide whether to read on. Settings lets you adjust length, style, and AI model; summaries run only when requested, sending just that article to the provider.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>A busy morning can leave you with dozens of unread articles. Which ones are worth your time? Press <strong>Summarize</strong> on any article and in a few seconds you get a short overview of its main points, right above the article. Read the summary, then decide whether to read the whole thing &mdash; or move on.</p>

    <p>Try it on any article in this demo. Each one has a summary ready to show you what it looks like.</p>

    <h3>Change the Length, Style, or Model</h3>

    <p>Prefer shorter summaries, bullet points, or a different focus? Set how long summaries should be, rewrite the instructions the AI follows, or pick a different AI model in Settings. Summaries work without any setup, and you can also connect your own account with an AI provider like Anthropic to use its models.</p>

    <p>Summaries only run when you ask for one, and only that article is sent to the AI provider; the <a href="/privacy">privacy policy</a> lists the providers. If a feed only sends a teaser, <a href="/demo/all?entry=full-content">fetch the full article</a> first and the summary covers the whole thing.</p>
  `,
};

export default article;
