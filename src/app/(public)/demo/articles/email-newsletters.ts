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
  summaryHtml: `<p>Lion Reader generates unique ingest email addresses that convert newsletters into feed entries. Subscribe to Substack, Ghost, or any newsletter using these addresses, and they appear in your unified timeline with full RSS-like features: starring, search, tags, and reading controls. Built-in security includes HMAC verification and sender blocking.</p>`,
  summaryModelId: "claude-sonnet-4-6",
  summaryGeneratedAt: new Date("2026-02-08"),
  contentHtml: `
    <p>Lots of great writing only arrives by email. Lion Reader gives you a private address to subscribe with, so newsletters land next to your feeds instead of burying your inbox. Each sender becomes its own subscription automatically, and its issues get everything a feed does: starring, <a href="/demo/all?entry=tags">tags</a>, <a href="/demo/all?entry=search">search</a>, <a href="/demo/all?entry=ai-summaries">summaries</a>, and <a href="/demo/all?entry=text-to-speech">narration</a>.</p>

    <h3>Getting Started</h3>

    <p>Create an address in Settings &mdash; label it if you like, such as &ldquo;Tech&rdquo; or &ldquo;Shopping&rdquo; &mdash; and use it anywhere a newsletter asks for your email. You can make more than one, so you can tell who&rsquo;s sharing your address, and delete any address that starts attracting spam.</p>

    <h3>Staying in Control</h3>

    <p>Block a sender and their mail stops showing up. Unsubscribe from a newsletter and, when the sender supports it, Lion Reader unsubscribes you from the mailing list too &mdash; no hunting for the tiny link at the bottom of the email.</p>
  `,
};

export default article;
