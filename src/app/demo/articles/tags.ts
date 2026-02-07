import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "tags",
  subscriptionId: "organization",
  type: "web",
  url: null,
  title: "Tags & Folders",
  author: null,
  summary: "Organize subscriptions with color-coded tags and browse entries by category.",
  publishedAt: new Date("2025-12-27T10:00:00Z"),
  starred: false,
  contentHtml: `
    <h2>Organize Your Way</h2>

    <p>Lion Reader gives you powerful tools to organize your subscriptions exactly how you want. Create custom tags with names and colors using the built-in hex color picker, then assign them to any combination of subscriptions. Tags are many-to-many, so a single subscription can belong to multiple categories &mdash; perfect for feeds that span multiple interests.</p>

    <p>Once you&rsquo;ve tagged your subscriptions, browse entries filtered by tag directly from the sidebar. Each tag shows real-time unread counts that update as you read and as new entries arrive. Subscriptions without tags appear in the &ldquo;Uncategorized&rdquo; section, so nothing gets lost. Tags work seamlessly across all feed types: web feeds (RSS/Atom/JSON), email newsletters, and saved articles.</p>

    <h3>Custom Titles and Flexible Management</h3>

    <p>Every subscription can be renamed to your preferred label, regardless of the original feed title. This is especially useful for newsletters with overly long names or feeds you want to remember differently. If you unsubscribe from a feed, Lion Reader uses soft deletion to preserve your read and starred state. Resubscribing later restores your full history, so you never lose track of what you&rsquo;ve already read.</p>

    <p>Key features:</p>
    <ul>
      <li><strong>Color-coded tags</strong> &mdash; Custom names with hex color picker</li>
      <li><strong>Many-to-many</strong> &mdash; One subscription can have multiple tags</li>
      <li><strong>Real-time counts</strong> &mdash; Unread counts per tag update live</li>
      <li><strong>Custom subscription titles</strong> &mdash; Rename any subscription to your preference</li>
      <li><strong>Soft-delete</strong> &mdash; Unsubscribing preserves your reading history</li>
    </ul>
  `,
};

export default article;
