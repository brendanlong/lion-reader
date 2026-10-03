import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "auth-security",
  subscriptionId: "lion-reader",
  type: "web",
  url: null,
  title: "Privacy & Security",
  author: null,
  summary:
    "Your reading habits stay private: no ads, no tracking, and full control over where you're signed in and what can access your account.",
  publishedAt: new Date("2025-12-26T11:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader protects your privacy &mdash; no ads, no data selling, no tracking &mdash; using your reading activity only to <strong>sync read and starred articles</strong> across devices. Sign in with email or Google/Apple, see and sign out your devices, revoke connected apps, and read articles <strong>cleaned of harmful code</strong> before display.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>What you read says a lot about you, so Lion Reader is built to keep it private. There are no ads, your data is never sold, and there&rsquo;s no third-party tracking script anywhere in the app. Your reading activity is used only to run the app for you, like keeping your read and starred articles in sync across your devices.</p>

    <h3>Signing In</h3>

    <p>Sign in with an email and password, or with an account you already have, like Google or Apple. You can see every device you&rsquo;re signed in on &mdash; with its browser and when it was last active &mdash; and sign any of them out instantly.</p>

    <h3>Controlling What Has Access</h3>

    <p>When you connect a <a href="/demo/all?entry=browser-extension">browser extension</a>, an <a href="/demo/all?entry=mcp-server">AI assistant</a>, or the <a href="/demo/all?entry=discord-bot">Discord bot</a>, it gets only the access it needs &mdash; a save button can save articles but can&rsquo;t read your feeds. You can see when each connection was last used and revoke it at any time, and tokens you create yourself can be given an expiration date.</p>

    <h3>Safe to Read</h3>

    <p>Articles come from all over the web, so Lion Reader cleans every one before showing it to you, removing anything that could run code in your browser.</p>

    <details>
      <summary>About analytics</summary>
      <p>The hosted site sends a minimal, cookie-free page count to GoatCounter without loading any tracking script, and reports only the <em>kind</em> of page you opened &mdash; an article list, an article, a settings page &mdash; never which feed or article. Self-hosted copies send nothing at all.</p>
    </details>
  `,
};

export default article;
