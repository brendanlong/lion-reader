import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "wallabag-api",
  subscriptionId: "integrations",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/652",
  title: "Wallabag API",
  author: null,
  summary:
    "Save articles from your phone using the Wallabag app's share intent with Lion Reader's Wallabag-compatible API.",
  publishedAt: new Date("2026-02-22T20:33:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader implements a <strong>Wallabag-compatible API</strong> that lets you use the official Wallabag mobile apps on Android and iOS to save articles directly to your Lion Reader account. Share any URL from your phone to the Wallabag app, and it appears in Lion Reader as a saved article. The API also supports viewing, archiving, starring, and deleting saved articles from the app.</p>`,
  contentHtml: `
    <h2>Save Articles from Your Phone</h2>

    <p>One of the most convenient ways to save articles for later reading is through your phone&rsquo;s share menu. The <a href="https://wallabag.org/" target="_blank" rel="noopener noreferrer">Wallabag</a> mobile apps for Android and iOS register as share targets on your device, so you can save a URL from any app &mdash; your browser, Twitter, Reddit, Mastodon, or anywhere else &mdash; by tapping &ldquo;Share&rdquo; and selecting Wallabag. Lion Reader implements the Wallabag API as a compatibility layer, so these apps work seamlessly with your Lion Reader account.</p>

    <h3>Compatible Apps</h3>

    <p>The official Wallabag apps work with Lion Reader out of the box:</p>

    <ul>
      <li><strong><a href="https://play.google.com/store/apps/details?id=fr.gaulupeau.apps.InThePoche" target="_blank" rel="noopener noreferrer">wallabag</a></strong> &mdash; The official Wallabag app for Android, with share intent support and offline reading</li>
      <li><strong><a href="https://apps.apple.com/app/wallabag-2-official/id1170800946" target="_blank" rel="noopener noreferrer">wallabag 2</a></strong> &mdash; The official Wallabag app for iOS, with share extension and offline reading</li>
    </ul>

    <h3>What You Can Do</h3>

    <p>The Wallabag API is scoped to <strong>saved articles</strong> in Lion Reader, matching the read-it-later interface that Wallabag apps expect. Through the app you can:</p>

    <ul>
      <li><strong>Save URLs</strong> &mdash; Share any URL to the Wallabag app to save it to Lion Reader</li>
      <li><strong>Browse saved articles</strong> &mdash; View your saved articles list with pagination and filtering</li>
      <li><strong>Read offline</strong> &mdash; The app caches articles for offline reading</li>
      <li><strong>Archive articles</strong> &mdash; Mark articles as read (archived) from the app</li>
      <li><strong>Star articles</strong> &mdash; Star your favorites for quick access</li>
      <li><strong>Search</strong> &mdash; Full-text search across your saved articles</li>
      <li><strong>Delete</strong> &mdash; Remove saved articles you no longer need</li>
    </ul>

    <h3>Setup</h3>

    <p>Setting up is straightforward. In the Wallabag app, go to Settings and enter:</p>

    <ol>
      <li><strong>Server URL</strong> &mdash; Your Lion Reader URL with the Wallabag path (e.g., <code>https://lionreader.com/api/wallabag</code>)</li>
      <li><strong>Client ID</strong> &mdash; <code>wallabag</code></li>
      <li><strong>Client Secret</strong> &mdash; <code>wallabag</code></li>
      <li><strong>Username</strong> &mdash; Your Lion Reader email address</li>
      <li><strong>Password</strong> &mdash; Your Lion Reader password</li>
    </ol>

    <p>Lion Reader also provides a <strong>QR code</strong> and a <strong>deep link</strong> in Settings &gt; Integrations that pre-fill the server URL and your email address, so you only need to enter your password.</p>

    <h3>How It Works</h3>

    <p>The Wallabag API is implemented as a thin translation layer under <code>/api/wallabag/</code>. It follows the same pattern as the <a href="/demo/all?entry=google-reader-api">Google Reader API</a> &mdash; each endpoint translates between the Wallabag wire format and Lion Reader&rsquo;s existing services layer. This means saving an article through the Wallabag app uses the same <code>saveArticle</code> service as the web UI, <a href="/demo/all?entry=browser-extension">browser extension</a>, <a href="/demo/all?entry=mcp-server">MCP server</a>, and <a href="/demo/all?entry=discord-bot">Discord bot</a>.</p>

    <p>Authentication uses OAuth 2.0 password grant, reusing Lion Reader&rsquo;s existing token infrastructure. The client ID and secret are both <code>wallabag</code> &mdash; since Lion Reader validates credentials directly against user accounts, there is no need for per-client registration.</p>

    <p>Entry IDs are mapped between Lion Reader&rsquo;s UUIDv7 format and Wallabag&rsquo;s integer IDs using a deterministic SHA-256 hash. This mapping is stable and reversible without storing any extra data.</p>

    <h3>Other Ways to Save</h3>

    <p>The Wallabag app is one of several ways to save articles in Lion Reader. You can also save via the <a href="/demo/all?entry=browser-extension">browser extension</a>, the <a href="/demo/all?entry=save-for-later">bookmarklet</a>, the <a href="/demo/all?entry=pwa">PWA share target</a>, the <a href="/demo/all?entry=discord-bot">Discord bot</a>, or the <a href="/demo/all?entry=mcp-server">MCP server</a> from AI assistants. All methods use the same underlying save service, so your saved articles end up in the same place regardless of how you captured them.</p>
  `,
};

export default article;
