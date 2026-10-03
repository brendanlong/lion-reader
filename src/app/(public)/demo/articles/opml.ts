import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "opml",
  subscriptionId: "organization",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/74",
  title: "Import & Export Your Subscriptions",
  author: null,
  summary:
    "Bring your subscriptions from another feed reader in one step, and take them with you whenever you like.",
  publishedAt: new Date("2025-12-28T14:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader supports full OPML import and export for migrating feed subscriptions between readers. Import processes run in the background with real-time progress updates, preserving folder/tag structure while validating feeds. Export generates OPML 2.0 with custom titles and complete hierarchy, compatible with any OPML-supporting reader.</p>`,
  summaryModelId: "claude-sonnet-4-6",
  summaryGeneratedAt: new Date("2026-02-07"),
  contentHtml: `
    <p>Switching from another feed reader? Export your subscriptions from it as an OPML file &mdash; the standard format nearly every reader supports &mdash; and import it into Lion Reader. Your folders come along as <a href="/demo/all?entry=tags">tags</a>.</p>

    <p>You can keep using the app while the import runs and watch it progress. When it&rsquo;s done, you&rsquo;ll see which feeds were added, which you already had, and which couldn&rsquo;t be reached, so dead feeds don&rsquo;t quietly pile up.</p>

    <h3>Take It With You</h3>

    <p>Export all your subscriptions, with your tags and custom names, in one click. Keep it as a backup, share a list with a friend, or move to another reader &mdash; your subscriptions are never locked in.</p>
  `,
};

export default article;
