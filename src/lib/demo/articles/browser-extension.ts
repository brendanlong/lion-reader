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
  summaryHtml: `<p>The Lion Reader browser extension saves articles as you browse &mdash; click the toolbar button, use a keyboard shortcut, or right-click to save a link without opening it. Paywalled pages keep only their public part, and saved Google Docs keep their real content instead of a sign-in page.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>The Lion Reader extension is the fastest way to save articles as you browse. Click the toolbar button, press <kbd>Ctrl+Shift+S</kbd> (<kbd>Cmd+Shift+S</kbd> on a Mac), or right-click any page or link and choose &ldquo;Save to Lion Reader&rdquo; &mdash; you can save a link without even opening it. The article lands in your <a href="/demo/all?entry=save-for-later">saved articles</a>, cleaned up and ready to read.</p>

    <p>The first time you save, the extension asks you to sign in to your Lion Reader account. After that, saving is a single click with no new tabs. As with any <a href="/demo/all?entry=save-for-later">save</a>, paywalled articles keep only their public part. Private Google Docs are the exception: the first time you save one from the toolbar button, Lion Reader asks for permission to read your Google Docs, so you get the real document instead of a sign-in page.</p>

    <p>Want every new post from a site instead of just this page? <a href="/demo/all?entry=rss-atom">Follow the site</a> in Lion Reader. On your phone, save from the <a href="/demo/all?entry=pwa">share menu</a> instead.</p>

    <h3>Install</h3>

    <ul>
      <li><a href="https://addons.mozilla.org/en-US/firefox/addon/lion-reader/" target="_blank" rel="noopener noreferrer">Firefox Add-ons</a></li>
      <li><a href="https://chromewebstore.google.com/detail/lion-reader/mpjddkjjkckmclaifjfokjppfoenmlpl" target="_blank" rel="noopener noreferrer">Chrome Web Store</a>, which also works for Chromium browsers like Edge and Brave</li>
    </ul>
  `,
};

export default article;
