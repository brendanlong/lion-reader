import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "tags",
  subscriptionId: "organization",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/92",
  title: "Tags",
  author: null,
  summary:
    "Group your subscriptions with color-coded tags, read one topic at a time, and rename anything to suit you.",
  publishedAt: new Date("2025-12-27T10:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader lets you organize subscriptions with <strong>custom tags</strong> (many-to-many relationships) featuring personalized names and colors. Browse entries by tag with real-time unread counts, rename any subscription, and enjoy soft deletion that preserves your read/starred history across all feed types.</p>`,
  summaryModelId: "claude-sonnet-4-6",
  summaryGeneratedAt: new Date("2026-02-07"),
  contentHtml: `
    <p>Group your subscriptions with tags &mdash; &ldquo;News,&rdquo; &ldquo;Friends,&rdquo; &ldquo;Work&rdquo; &mdash; and give each one a color. A subscription can have as many tags as you like, so a blog about cooking and travel can live in both places.</p>

    <p>Each tag shows up in the sidebar with its own unread count, so you can read one topic at a time. Subscriptions you haven&rsquo;t tagged appear under &ldquo;Uncategorized,&rdquo; so nothing gets lost. Tags work for everything: <a href="/demo/all?entry=rss-atom">feeds</a>, <a href="/demo/all?entry=email-newsletters">newsletters</a>, and more.</p>

    <h3>Your Names, Not Theirs</h3>

    <p>Rename any subscription to whatever you&rsquo;ll recognize &mdash; handy for newsletters with long names or feeds you think of differently. And if you unsubscribe and change your mind later, resubscribing brings back what you&rsquo;d already read and starred.</p>
  `,
};

export default article;
