import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "open-source",
  subscriptionId: "lion-reader",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader",
  title: "Open Source & Self-Hostable",
  author: null,
  summary:
    "Lion Reader is free and open source. Read the code, run your own copy, or help build it on GitHub.",
  publishedAt: new Date("2025-12-26T10:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader is <strong>free and open source</strong> under the MIT license. Use the hosted version, or self-host your own copy with just a database and a cache; optional features like Google sign-in, AI summaries, or newsletters can be enabled individually. Subscriptions export to a standard file, and contributions are welcome.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>Lion Reader is free and <a href="https://github.com/brendanlong/lion-reader" target="_blank" rel="noopener noreferrer">open source</a> under the MIT license. You can use the hosted version at lionreader.com, or run your own copy and keep every feed, article, and setting on hardware you control.</p>

    <h3>Run Your Own</h3>

    <p>Lion Reader comes with a Dockerfile and needs only a database and a cache alongside it. It runs comfortably on a small, inexpensive server, and grows by adding more servers when you need them. Features that depend on outside services &mdash; like signing in with Google, AI summaries, or receiving newsletters &mdash; are optional, so you can turn on just the ones you want.</p>

    <h3>No Lock-In</h3>

    <p>Your subscriptions export to a <a href="/demo/all?entry=opml">standard file</a> any feed reader can import, and Lion Reader works with <a href="/demo/all?entry=google-reader-api">existing RSS apps</a>. If you ever want to leave, you can take everything with you.</p>

    <h3>Get Involved</h3>

    <p>Bug reports, feature ideas, and pull requests are all welcome. Browse the <a href="https://github.com/brendanlong/lion-reader/issues" target="_blank" rel="noopener noreferrer">open issues</a> to find something to work on; the repository includes design docs and diagrams to help you find your way around.</p>
  `,
};

export default article;
