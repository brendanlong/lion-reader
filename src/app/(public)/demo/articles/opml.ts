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
  summaryHtml: `<p>Export your subscriptions from another feed reader as an <strong>OPML file</strong> and import them into Lion Reader, with folders carried over as tags. Keep using the app while the import runs, and see which feeds were added, already existed, or couldn&rsquo;t be imported. Export to back up or switch readers.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>Switching from another feed reader? Export your subscriptions from it as an OPML file &mdash; the standard format nearly every reader supports &mdash; and import it into Lion Reader. Your folders come along as <a href="/demo/all?entry=tags">tags</a>.</p>

    <p>You can keep using the app while the import runs and watch it progress. When it&rsquo;s done, you&rsquo;ll see which feeds were added, which you already had, and any that couldn&rsquo;t be imported. Feeds that turn out to be dead show up under Broken Feeds in Settings, so they don&rsquo;t quietly pile up.</p>

    <h3>Take It With You</h3>

    <p>Export all your feeds, with your tags and custom names, in one click. Keep it as a backup, share a list with a friend, or move to another reader &mdash; your subscriptions are never locked in.</p>
  `,
};

export default article;
