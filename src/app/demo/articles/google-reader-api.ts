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
  heroImage: "/demo/google-reader-api.png",
  heroImageAlt:
    "The Lion Reader lion syncing with a phone and a desktop feed reader via two-way arrows.",
  summaryHtml: `<p>Lion Reader supports the <strong>Google Reader API</strong>, enabling sync with third-party RSS apps like Reeder Classic, NetNewsWire, and NewsFlash. Compatible apps sync subscriptions, read state, starred and saved articles, tags, and unread counts. To set up, select <strong>FreshRSS</strong> as the service type in your app and enter your Lion Reader credentials.</p>`,
  contentHtml: `
    <h2>Use Your Favorite RSS App</h2>

    <p>While Lion Reader&rsquo;s web interface is designed to be a great reading experience, sometimes you want to read on a native app &mdash; on your phone during a commute, on a tablet on the couch, or in a desktop app that integrates with your OS. The Google Reader-compatible API makes this possible by letting third-party RSS reader apps sync directly with your Lion Reader account.</p>

    <p>The <a href="https://feedhq.readthedocs.io/en/latest/api/" target="_blank" rel="noopener noreferrer">Google Reader API</a> is a widely-adopted protocol originally created by Google Reader before it was shut down in 2013. Since then, it has become the de facto standard for RSS reader sync &mdash; nearly every RSS app supports it. Lion Reader implements this protocol as a thin translation layer over its existing services, so everything stays in sync.</p>

    <h3>Compatible Apps</h3>

    <p>Any app that supports the Google Reader API should work with Lion Reader. Some popular options include:</p>

    <ul>
      <li><a href="https://reederapp.com/classic/" target="_blank" rel="noopener noreferrer"><strong>Reeder Classic</strong></a> &mdash; A beautiful RSS reader for iOS and macOS</li>
      <li><a href="https://netnewswire.com/" target="_blank" rel="noopener noreferrer"><strong>NetNewsWire</strong></a> &mdash; A free, open-source reader for iOS and macOS</li>
      <li><a href="https://play.google.com/store/apps/details?id=allen.town.focus.reader" target="_blank" rel="noopener noreferrer"><strong>FocusReader</strong></a> &mdash; A feature-rich RSS reader for Android</li>
      <li><a href="https://f-droid.org/packages/me.ash.reader" target="_blank" rel="noopener noreferrer"><strong>Read You</strong></a> &mdash; A modern, Material Design reader for Android</li>
      <li><a href="https://flathub.org/apps/io.gitlab.news_flash.NewsFlash" target="_blank" rel="noopener noreferrer"><strong>NewsFlash</strong></a> &mdash; A GTK4 feed reader for Linux</li>
    </ul>

    <h3>What Syncs</h3>

    <p>The API provides full two-way sync for everything you&rsquo;d expect:</p>

    <ul>
      <li><strong>Subscriptions</strong> &mdash; All your feeds appear in the app, and you can subscribe or unsubscribe from within the app</li>
      <li><strong>Read state</strong> &mdash; Mark articles as read on your phone and they&rsquo;re read everywhere</li>
      <li><strong>Starred articles</strong> &mdash; Star articles from any client and they sync across all your devices</li>
      <li><strong>Saved articles</strong> &mdash; Articles you <a href="/demo/all?entry=save-for-later">save for later</a> appear as a special &ldquo;Saved Articles&rdquo; subscription, so your read-it-later list comes along too</li>
      <li><strong>Tags/folders</strong> &mdash; Your Lion Reader tags appear as folders in compatible apps, and you can create, rename, and delete them</li>
      <li><strong>Unread counts</strong> &mdash; See accurate unread counts per subscription and per folder</li>
    </ul>

    <h3>Setup</h3>

    <p>Setting up is straightforward. In your RSS app, look for &ldquo;<a href="https://freshrss.org/" target="_blank" rel="noopener noreferrer">FreshRSS</a>&rdquo; as the service type, then enter:</p>

    <ol>
      <li><strong>Server URL</strong> &mdash; Your Lion Reader instance URL with the FreshRSS path (e.g., <code>https://lionreader.com/api/greader.php</code>)</li>
      <li><strong>Email</strong> &mdash; Your Lion Reader email address</li>
      <li><strong>Password</strong> &mdash; Your Lion Reader password</li>
    </ol>

    <p>That&rsquo;s it. The app will authenticate using the ClientLogin protocol and start syncing your feeds immediately. No API tokens or special configuration required.</p>

    <h3>How It Works</h3>

    <p>The Google Reader API is implemented as a set of Next.js route handlers under <code>/api/greader.php/reader/api/0/</code> (with authentication at <code>/api/greader.php/accounts/ClientLogin</code>). Rather than duplicating business logic, each endpoint is a thin translation layer that converts between the Google Reader wire format and Lion Reader&rsquo;s existing services layer. This means behavior is identical whether you&rsquo;re reading through the web UI, the <a href="/demo/all?entry=mcp-server">MCP server</a>, the <a href="/demo/all?entry=wallabag-api">Wallabag API</a>, or a third-party app.</p>

    <p>One interesting challenge is ID mapping. Google Reader clients expect signed 64-bit integer IDs, but Lion Reader uses UUIDv7 (128-bit) internally. Every id a client sees &mdash; items, feeds, tags, users &mdash; is a stored integer serial kept alongside the UUID, so the ids are stable and map back to the real records with a simple indexed lookup.</p>
  `,
};

export default article;
