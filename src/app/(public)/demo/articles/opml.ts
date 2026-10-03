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
  summaryHtml: `<p>Import an OPML file exported from another feed reader, like Feedly or Inoreader, and Lion Reader adds its subscriptions while turning folders into <strong>tags</strong>. The import runs in the background and reports which feeds were added, duplicates, or failed. You can also export your subscription list, with tags and names.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>Switching from another feed reader, like Feedly or Inoreader? Export your subscriptions from it as an OPML file &mdash; the standard format nearly every feed reader offers in its settings &mdash; and import it into Lion Reader. Your folders come along as <a href="/demo/all?entry=tags">tags</a>.</p>

    <p>You can keep using the app while the import runs and watch it progress. When it&rsquo;s done, you&rsquo;ll see which feeds were added, which you already had, and any that couldn&rsquo;t be imported, and each feed&rsquo;s recent posts show up shortly after. Want to keep the mobile app you already use? Lion Reader <a href="/demo/all?entry=google-reader-api">works with many RSS apps</a> too.</p>

    <h3>Take It With You</h3>

    <p>Export your subscription list, with your tags and custom names, in one click. Keep it as a backup, share a list with a friend, or move to another reader.</p>
  `,
};

export default article;
