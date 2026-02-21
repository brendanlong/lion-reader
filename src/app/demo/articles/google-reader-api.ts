import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "google-reader-api",
  subscriptionId: "integrations",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/605",
  title: "Google Reader API",
  author: null,
  summary:
    "Sync Lion Reader with mobile and desktop RSS apps using the Google Reader-compatible API.",
  publishedAt: new Date("2026-02-20T01:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader now includes a <strong>Google Reader-compatible API</strong>, allowing you to sync your subscriptions, read state, starred articles, and tags with popular third-party RSS reader apps like Reeder, NetNewsWire, FeedMe, Read You, and NewsFlash. The API uses your existing Lion Reader credentials and requires no additional setup beyond pointing your app at your Lion Reader server.</p>`,
  contentHtml: `
    <h2>Use Your Favorite RSS App</h2>

    <p>While Lion Reader&rsquo;s web interface is designed to be a great reading experience, sometimes you want to read on a native app &mdash; on your phone during a commute, on a tablet on the couch, or in a desktop app that integrates with your OS. The Google Reader-compatible API makes this possible by letting third-party RSS reader apps sync directly with your Lion Reader account.</p>

    <p>The <a href="https://feedhq.readthedocs.io/en/latest/api/" target="_blank" rel="noopener noreferrer">Google Reader API</a> is a widely-adopted protocol originally created by Google Reader before it was shut down in 2013. Since then, it has become the de facto standard for RSS reader sync &mdash; nearly every RSS app supports it. Lion Reader implements this protocol as a thin translation layer over its existing services, so everything stays in sync.</p>

    <h3>Compatible Apps</h3>

    <p>Any app that supports the Google Reader API should work with Lion Reader. Some popular options include:</p>

    <ul>
      <li><strong>Reeder</strong> &mdash; A beautiful RSS reader for iOS and macOS</li>
      <li><strong>NetNewsWire</strong> &mdash; A free, open-source reader for iOS and macOS</li>
      <li><strong>FeedMe</strong> &mdash; A popular RSS reader for Android</li>
      <li><strong>Read You</strong> &mdash; A modern, Material Design reader for Android</li>
      <li><strong>NewsFlash</strong> &mdash; A GTK4 feed reader for Linux</li>
    </ul>

    <h3>What Syncs</h3>

    <p>The API provides full two-way sync for everything you&rsquo;d expect:</p>

    <ul>
      <li><strong>Subscriptions</strong> &mdash; All your feeds appear in the app, and you can subscribe or unsubscribe from within the app</li>
      <li><strong>Read state</strong> &mdash; Mark articles as read on your phone and they&rsquo;re read everywhere</li>
      <li><strong>Starred articles</strong> &mdash; Star articles from any client and they sync across all your devices</li>
      <li><strong>Tags/folders</strong> &mdash; Your Lion Reader tags appear as folders in compatible apps, and you can create, rename, and delete them</li>
      <li><strong>Unread counts</strong> &mdash; See accurate unread counts per subscription and per folder</li>
    </ul>

    <h3>Setup</h3>

    <p>Setting up is straightforward. In your RSS app, look for &ldquo;FreshRSS&rdquo; as the service type, then enter:</p>

    <ol>
      <li><strong>Server URL</strong> &mdash; Your Lion Reader instance URL with the FreshRSS path (e.g., <code>https://lionreader.com/api/greader.php</code>)</li>
      <li><strong>Email</strong> &mdash; Your Lion Reader email address</li>
      <li><strong>Password</strong> &mdash; Your Lion Reader password</li>
    </ol>

    <p>That&rsquo;s it. The app will authenticate using the ClientLogin protocol and start syncing your feeds immediately. No API tokens or special configuration required.</p>

    <h3>How It Works</h3>

    <p>The Google Reader API is implemented as a set of Next.js route handlers under <code>/api/greader.php/reader/api/0/</code> (with authentication at <code>/api/greader.php/accounts/ClientLogin</code>). Rather than duplicating business logic, each endpoint is a thin translation layer that converts between the Google Reader wire format and Lion Reader&rsquo;s existing services layer. This means behavior is identical whether you&rsquo;re reading through the web UI, the <a href="/demo/all?entry=mcp-server">MCP server</a>, or a third-party app.</p>

    <p>One interesting challenge is ID mapping. Google Reader clients expect signed 64-bit integer IDs, but Lion Reader uses UUIDv7 (128-bit). The API derives a deterministic 63-bit integer from each UUID by extracting the 48-bit timestamp and 15 bits of randomness. This preserves time-ordering (so clients sort correctly) and is fully reversible without any extra storage.</p>
  `,
};

export default article;
