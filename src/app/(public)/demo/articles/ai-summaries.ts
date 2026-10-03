import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "ai-summaries",
  subscriptionId: "reading-experience",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/298",
  title: "AI Summaries",
  author: null,
  summary:
    "Get a short summary of any article in a couple of seconds, so you can decide what's worth reading in full.",
  publishedAt: new Date("2026-01-16T12:00:00Z"),
  starred: true,
  summaryHtml: `<p>Lion Reader offers <strong>on-demand AI summaries</strong> to help triage unread articles. Unlike auto-summarizing readers, summaries are only generated when you click &quot;Summarize.&quot; Results are <strong>cached and shared across users</strong> to reduce costs, letting you quickly scan summaries to prioritize your reading list.</p>`,
  summaryModelId: "claude-sonnet-4-6",
  summaryGeneratedAt: new Date("2026-02-08"),
  contentHtml: `
    <p>A busy morning can leave you with dozens of unread articles. Which ones are worth your time? Press <strong>Summarize</strong> on any article and in a few seconds you get a short overview of its main points, right above the article. Read the summary, then decide whether to read the whole thing &mdash; or move on.</p>

    <p>Try it on any article in this demo. Each one has a summary ready to show you what it looks like.</p>

    <h3>Only When You Ask</h3>

    <p>Lion Reader never summarizes your articles in the background. Nothing is sent to an AI model until you press the button, and only for that one article.</p>

    <h3>Make It Yours</h3>

    <p>Prefer shorter summaries, bullet points, or a different focus? Set how long summaries should be, rewrite the instructions the AI follows, or pick a different AI model in Settings. You can also add your own key from a supported AI provider to use its models.</p>

    <p>If a feed only sends a teaser, <a href="/demo/all?entry=full-content">fetch the full article</a> first and the summary covers the whole thing.</p>
  `,
};

export default article;
