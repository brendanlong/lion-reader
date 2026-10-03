import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "browser-extension",
  subscriptionId: "integrations",
  type: "web",
  url: "https://addons.mozilla.org/en-US/firefox/addon/lion-reader/",
  title: "Browser Extension",
  author: null,
  summary:
    "Save the page you're reading to Lion Reader with one click, a keyboard shortcut, or a right-click, in Firefox and Chrome.",
  publishedAt: new Date("2026-01-10T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>The Lion Reader browser extension lets you save any web page for later reading with a single click, a keyboard shortcut, or the right-click context menu. Available for <strong>Firefox</strong> and <strong>Chrome</strong>, the extension automatically extracts article content using Mozilla Readability, stores an API token for future saves, and handles Google Docs with automatic OAuth.</p>`,
  summaryModelId: "claude-sonnet-4-6",
  summaryGeneratedAt: new Date("2026-02-25"),
  contentHtml: `
    <p>The Lion Reader extension is the fastest way to save articles as you browse. Click the toolbar button, press <kbd>Ctrl+Shift+S</kbd> (<kbd>Cmd+Shift+S</kbd> on a Mac), or right-click any page or link and choose &ldquo;Save to Lion Reader.&rdquo; The article lands in your <a href="/demo/all?entry=save-for-later">saved articles</a>, cleaned up and ready to read.</p>

    <p>The first time you save, the extension asks you to sign in. After that, saving is a single click with no new tabs. Saving a Google Doc? The extension asks for permission to read it, so you get the real document instead of a sign-in page.</p>

    <h3>Install</h3>

    <ul>
      <li><a href="https://addons.mozilla.org/en-US/firefox/addon/lion-reader/" target="_blank" rel="noopener noreferrer">Firefox Add-ons</a></li>
      <li><a href="https://chromewebstore.google.com/detail/lion-reader/mpjddkjjkckmclaifjfokjppfoenmlpl" target="_blank" rel="noopener noreferrer">Chrome Web Store</a></li>
    </ul>

    <p>Running your own copy of Lion Reader? Point the extension at your server in its settings.</p>
  `,
};

export default article;
