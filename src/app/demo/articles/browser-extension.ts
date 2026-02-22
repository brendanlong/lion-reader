import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "browser-extension",
  subscriptionId: "integrations",
  type: "web",
  url: "https://addons.mozilla.org/en-US/firefox/addon/lion-reader/",
  title: "Browser Extension",
  author: null,
  summary:
    "Save articles to Lion Reader with one click using the browser extension for Firefox and Chrome.",
  publishedAt: new Date("2026-01-10T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>The Lion Reader browser extension lets you save any web page for later reading with a single click, a keyboard shortcut, or the right-click context menu. Available for <strong>Firefox</strong> (published on AMO) and <strong>Chrome</strong> (coming soon), the extension automatically extracts article content using Mozilla Readability, stores an API token for future saves, and handles Google Docs with automatic OAuth.</p>`,
  contentHtml: `
    <h2>Save While You Browse</h2>

    <p>The Lion Reader browser extension is the fastest way to save articles as you come across them. Instead of switching to the Lion Reader tab to paste a URL, just click the toolbar button and the article is saved immediately. The extension uses the same content extraction as the rest of Lion Reader &mdash; Mozilla&rsquo;s <a href="https://github.com/mozilla/readability" target="_blank" rel="noopener noreferrer">Readability algorithm</a> &mdash; so you get clean, distraction-free content every time.</p>

    <h3>Three Ways to Save</h3>

    <ul>
      <li><strong>Toolbar button</strong> &mdash; Click the Lion Reader icon in your browser toolbar to save the current page</li>
      <li><strong>Keyboard shortcut</strong> &mdash; Press <kbd>Ctrl+Shift+S</kbd> (or <kbd>Cmd+Shift+S</kbd> on Mac) for instant saving without reaching for the mouse</li>
      <li><strong>Context menu</strong> &mdash; Right-click any page or link and select &ldquo;Save to Lion Reader&rdquo; to save it</li>
    </ul>

    <h3>How It Works</h3>

    <p>The first time you save an article, the extension opens a tab to authenticate with your Lion Reader account. Once logged in, the article is saved and the extension receives a scoped API token for future saves. From then on, saving is instant &mdash; the extension calls the Lion Reader API directly without needing to open any tabs.</p>

    <p>Saved articles appear in your <strong>Saved</strong> section in the sidebar, fully integrated with the rest of Lion Reader. You can star them, tag them, search across them, read them with text-to-speech, and generate AI summaries &mdash; everything you can do with RSS entries.</p>

    <h3>Google Docs Support</h3>

    <p>When you save a Google Docs URL, the extension detects it automatically and prompts for the necessary OAuth permissions. Once granted, Lion Reader fetches the document content directly from the Google Docs API, preserving formatting and structure far better than a regular web page save.</p>

    <h3>Installation</h3>

    <p>The extension is available for Firefox and Chrome:</p>

    <ul>
      <li><strong>Firefox</strong> &mdash; Install from <a href="https://addons.mozilla.org/en-US/firefox/addon/lion-reader/" target="_blank" rel="noopener noreferrer">Firefox Add-ons (AMO)</a></li>
      <li><strong>Chrome</strong> &mdash; Coming soon to the Chrome Web Store. In the meantime, the extension can be loaded manually for development.</li>
    </ul>

    <h3>Self-Hosted Instances</h3>

    <p>If you&rsquo;re running a self-hosted Lion Reader instance, the extension can be configured to point to your server. By default it connects to <code>lionreader.com</code>, but you can change the backend URL in the extension&rsquo;s settings to use <code>localhost:3000</code> or any other Lion Reader deployment.</p>

    <h3>Other Ways to Save</h3>

    <p>The browser extension is one of several ways to save articles in Lion Reader. You can also save via the <a href="/demo/all?entry=save-for-later">bookmarklet</a>, the <a href="/demo/all?entry=wallabag-api">Wallabag app</a> on mobile, the <a href="/demo/all?entry=pwa">PWA share target</a>, the <a href="/demo/all?entry=discord-bot">Discord bot</a>, or the <a href="/demo/all?entry=mcp-server">MCP server</a> from AI assistants. All methods use the same underlying save service, so your saved articles end up in the same place regardless of how you captured them.</p>
  `,
};

export default article;
