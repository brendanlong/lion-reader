import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "search",
  subscriptionId: "organization",
  type: "web",
  url: null,
  title: "Full-Text Search",
  author: null,
  summary: "Search across all your entries by title, content, or both with instant results.",
  publishedAt: new Date("2025-12-28T10:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader&#39;s full-text search uses PostgreSQL with English language stemming to deliver fast, relevant results across your entire archive. You can search by title, content, or both, with configurable scope to narrow your focus.</p>
<p><strong>Key Features:</strong></p>
<ul>
<li><strong>Flexible filtering</strong> — Combine search with subscription, tag, read/unread state, starred status, or entry type</li>
<li><strong>Relevance ranking</strong> — Results ranked by PostgreSQL&#39;s ts_rank algorithm, prioritizing title matches over body text</li>
<li><strong>High performance</strong> — Database-level full-text indexing ensures speed even with thousands of entries</li>
<li><strong>Cursor-based pagination</strong> — Scroll through unlimited results without performance degradation</li>
<li><strong>Universal availability</strong> — Search works in the web UI, tRPC API, and MCP server for AI assistant integrations</li>
</ul>
<p>The search makes it easy to find specific content within a newsletter, across saved articles, or just your starred items.</p>`,
  contentHtml: `
    <h2>Search Everything, Instantly</h2>

    <p>Lion Reader&rsquo;s full-text search is powered by PostgreSQL with English language stemming, giving you fast, relevant results across your entire archive. Search by title, content, or both &mdash; the search scope is fully configurable, so you can narrow down exactly what you&rsquo;re looking for.</p>

    <p>Search results can be combined with any other filter in Lion Reader: subscription, tag, read/unread state, starred entries, or entry type. This makes it easy to search within a specific newsletter, across all saved articles, or just your starred items. Results are ranked by relevance using PostgreSQL&rsquo;s <code>ts_rank</code> algorithm, which weights matches in titles higher than those in body text.</p>

    <h3>Performance and Availability</h3>

    <p>Even with large archives containing thousands of entries, search remains fast thanks to database-level full-text indexing. Results use cursor-based pagination, so you can scroll through unlimited result sets without performance degradation. Search is available everywhere: the web UI, the tRPC API, and the MCP server for AI assistant integrations.</p>

    <p>Search capabilities:</p>
    <ul>
      <li><strong>Full-text search</strong> &mdash; Across title, summary, and content</li>
      <li><strong>Configurable scope</strong> &mdash; Title-only, content-only, or both</li>
      <li><strong>Combine with filters</strong> &mdash; Subscription, tag, read state, starred, entry type</li>
      <li><strong>Relevance ranking</strong> &mdash; Results ranked by <code>ts_rank</code></li>
      <li><strong>Fast indexing</strong> &mdash; Database-level full-text indexes</li>
      <li><strong>Cursor-based pagination</strong> &mdash; Efficient for large result sets</li>
    </ul>
  `,
};

export default article;
