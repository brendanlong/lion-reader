import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "email-newsletters",
  subscriptionId: "feed-types",
  type: "email",
  url: "https://github.com/brendanlong/lion-reader/pull/47",
  title: "Email Newsletters",
  author: null,
  summary:
    "Get a private email address for newsletters, and read them alongside your feeds instead of in your inbox.",
  publishedAt: new Date("2025-12-30T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader gives you a private email address for newsletters, keeping them next to your feeds instead of your inbox. Each sender becomes its own subscription with <strong>starring, tags, search, summaries, and narration</strong>. Create multiple addresses in Settings, and unsubscribing blocks the sender and, where supported, takes you off the mailing list.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>Lots of great writing only arrives by email. Lion Reader gives you a private address to subscribe with, so newsletters land next to your feeds instead of burying your inbox. Each sender becomes its own subscription automatically, and its issues get everything a feed does: starring, <a href="/demo/all?entry=tags">tags</a>, <a href="/demo/all?entry=search">search</a>, <a href="/demo/all?entry=ai-summaries">summaries</a>, and <a href="/demo/all?entry=text-to-speech">narration</a>.</p>

    <h3>Getting Started</h3>

    <p>Create an address in Settings &mdash; label it if you like, such as &ldquo;Tech&rdquo; or &ldquo;Shopping&rdquo; &mdash; and use it anywhere a newsletter asks for your email. You can make more than one, so you can tell who&rsquo;s sharing your address, and delete any address that starts attracting spam.</p>

    <h3>Staying in Control</h3>

    <p>Unsubscribe from a newsletter and Lion Reader blocks that sender, so their mail stops showing up &mdash; and for newsletters that support one-click unsubscribe, it takes you off the mailing list too, with no hunting for the tiny link at the bottom of the email. Changed your mind? Unblock the sender in Settings.</p>
  `,
};

export default article;
