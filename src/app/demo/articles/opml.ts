import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "opml",
  subscriptionId: "organization",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/74",
  title: "OPML Import & Export",
  author: null,
  summary:
    "Migrate to or from Lion Reader with standard OPML files, or back up your subscriptions.",
  publishedAt: new Date("2025-12-28T14:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader supports full OPML import and export for migrating feed subscriptions between readers. Import processes run in the background with real-time progress updates, preserving folder/tag structure while validating feeds. Export generates OPML 2.0 with custom titles and complete hierarchy, compatible with any OPML-supporting reader.</p>`,
  contentHtml: `
    <h2>Portable Subscriptions</h2>

    <p>OPML (Outline Processor Markup Language) is the standard format for exchanging feed subscriptions between readers. Lion Reader supports full OPML import and export, making it easy to migrate to or from any other feed reader, or simply back up your subscriptions. The OPML format is documented in the <a href="http://opml.org/spec2.opml" target="_blank" rel="noopener noreferrer">OPML 2.0 specification</a>.</p>

    <h3>Import from Anywhere</h3>

    <p>Upload an OPML file from any feed reader &mdash; Feedly, Inoreader, NetNewsWire, or dozens of others. Lion Reader processes imports in the background with real-time progress updates delivered via Server-Sent Events. Each feed is validated and fetched during import to ensure it&rsquo;s still active. The importer preserves folder and tag structure from your original reader, translating folder hierarchies into Lion Reader&rsquo;s tag system.</p>

    <p>The import process is smart: it automatically skips feeds you&rsquo;re already subscribed to and provides detailed per-feed status reports. You&rsquo;ll see which feeds were successfully imported, which were skipped, and which failed with specific error messages. Lion Reader also supports service-specific migrations, including a dedicated Feedbin importer.</p>

    <h3>Export Your Library</h3>

    <p>Export all your subscriptions as OPML 2.0 with a single click. The export includes custom titles and your complete tag/folder hierarchy, making it compatible with any OPML-supporting reader. This is perfect for creating backups, migrating between readers, or sharing curated subscription lists with friends.</p>

    <p>OPML features:</p>
    <ul>
      <li><strong>Import</strong> &mdash; From any OPML-compatible reader</li>
      <li><strong>Live progress</strong> &mdash; Background processing with real-time SSE updates</li>
      <li><strong>Folder preservation</strong> &mdash; Tag structure imported from source reader</li>
      <li><strong>Per-feed status</strong> &mdash; Imported, skipped, or failed with error details</li>
      <li><strong>One-click export</strong> &mdash; OPML 2.0 with custom titles and tags</li>
      <li><strong>Service migrations</strong> &mdash; Dedicated importers for Feedbin and more</li>
    </ul>
  `,
};

export default article;
