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
  summaryHtml: `<p>Lion Reader is <strong>open source</strong> and free to use, hosted or self-run on hardware you control, so it never depends on one company staying in business. Subscriptions export to a standard OPML file, and the app works with existing RSS clients, letting you switch apps without switching services.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>Lion Reader is <a href="https://github.com/brendanlong/lion-reader" target="_blank" rel="noopener noreferrer">open source</a> under the MIT license. Use the free hosted version at lionreader.com, or run your own copy and keep every feed, article, and setting on hardware you control. Because the code is open, your reader never depends on one company deciding to keep it running.</p>

    <h3>Take Your Subscriptions Anywhere</h3>

    <p>Your subscriptions export to a <a href="/demo/all?entry=opml">standard OPML file</a> any feed reader can import, and Lion Reader works with <a href="/demo/all?entry=google-reader-api">existing RSS apps</a>, so you can switch apps without switching services.</p>

    <h3>Run Your Own</h3>

    <p>Lion Reader runs affordably at small scale. Features that depend on outside services &mdash; like signing in with Google, AI summaries, or receiving newsletters &mdash; are optional.</p>

    <details>
      <summary>What self-hosting needs</summary>
      <p>Lion Reader comes with a Dockerfile and needs a PostgreSQL database and a Redis cache alongside it. The <a href="https://github.com/brendanlong/lion-reader/blob/master/docs/DEPLOYMENT.md" target="_blank" rel="noopener noreferrer">deployment guide</a> walks through a full setup on Fly.io.</p>
    </details>

    <p>Bug reports, feature ideas, and pull requests are welcome on <a href="https://github.com/brendanlong/lion-reader/issues" target="_blank" rel="noopener noreferrer">GitHub</a>.</p>
  `,
};

export default article;
