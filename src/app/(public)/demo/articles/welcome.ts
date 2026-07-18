import { type DemoArticle } from "./types";
import heroImage from "./images/welcome.png";
import ogImage from "./images/welcome-og.png";
import { resolveWelcomePublishedAt } from "./welcome-published-at";

const article: DemoArticle = {
  id: "welcome",
  subscriptionId: "lion-reader",
  type: "web",
  url: null,
  title: "Welcome to Lion Reader",
  author: null,
  summary:
    "An AI-native, all-in-one reader for feeds, newsletters, and read-later. Explore the demo to see what it can do.",
  // Build/deploy-stamped so SSR and the post-hydration client render show the
  // identical time (no "31 minutes ago" → "just now" jump). See
  // resolveWelcomePublishedAt for the full rationale.
  publishedAt: resolveWelcomePublishedAt(process.env.NEXT_PUBLIC_BUILD_TIME),
  starred: true,
  heroImage,
  ogImage,
  heroImageAlt:
    "The Lion Reader lion waving hello, surrounded by feature motifs: a newspaper, a book with a bookmark, an email envelope, and a friendly robot.",
  summaryHtml: `<p><strong>Lion Reader</strong> is an AI-native, self-hostable reader that unifies RSS/Atom/JSON feeds, email newsletters, and saved articles in one fast interface. It connects to AI assistants over <strong>MCP</strong>, generates on-demand <strong>summaries</strong> via Claude, and narrates articles with synchronized highlighting &mdash; all with real-time, jank-free updates. Free and open source.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-07-03"),
  contentHtml: `
    <p>Lion Reader is a self-hostable feed reader for people who take their reading seriously. It brings your feeds, your newsletters, and everything you save for later into one fast, elegant interface &mdash; and it&rsquo;s built from the ground up to work with AI assistants.</p>

    <p>This interactive demo is the real Lion Reader UI. Browse the sidebar to explore each capability; everything here behaves exactly like the production app.</p>

    <h3>What makes it different</h3>

    <ul>
      <li><strong>AI-native, not AI-bolted-on</strong> &mdash; Connect Claude and other assistants directly to your reader over the <a href="/demo/all?entry=mcp-server"><strong>Model Context Protocol (MCP)</strong></a> to search, organize, save, and triage on your behalf. Generate concise article <a href="/demo/all?entry=ai-summaries"><strong>summaries</strong></a> on demand (never auto-summarized behind your back), and listen to any article with <a href="/demo/all?entry=text-to-speech"><strong>text-to-speech narration and synchronized highlighting</strong></a>.</li>
      <li><strong>Everything in one place</strong> &mdash; Subscribe to <a href="/demo/all?entry=rss-atom">RSS, Atom</a>, and <a href="/demo/all?entry=json-feed">JSON feeds</a>; receive <a href="/demo/all?entry=email-newsletters"><strong>email newsletters</strong></a> at a private ingest address; and <a href="/demo/all?entry=save-for-later">save any page for later</a> with <a href="/demo/all?entry=browser-extension">browser extensions</a>, a bookmarklet, a <a href="/demo/all?entry=discord-bot">Discord bot</a>, your <a href="/demo/all?entry=pwa">phone&rsquo;s share menu</a>, or <a href="/demo/all?entry=file-upload">Markdown/Word uploads</a>. Saving is <a href="/demo/all?entry=plugins">extra-smart for arXiv, GitHub, Google Docs, LessWrong, YouTube, and Bluesky</a>.</li>
      <li><a href="/demo/all?entry=performance"><strong>Obsessively fast</strong></a> &mdash; New entries show up in the list you&rsquo;re reading without a refresh and without disturbing your place, and moving around the app is instant &mdash; served straight from cache wherever possible, with nothing else reloading.</li>
      <li><strong>All the essentials, done well</strong> &mdash; <a href="/demo/all?entry=full-content">Full-content fetching</a>, <a href="/demo/all?entry=tags">tags</a>, <a href="/demo/all?entry=keyboard-shortcuts">keyboard-first navigation</a>, <a href="/demo/all?entry=opml">OPML import/export</a>, an installable <a href="/demo/all?entry=pwa">PWA</a>, and clean modern styling with <a href="/demo/all?entry=appearance">light and dark themes</a>.</li>
      <li><strong>Yours to own</strong> &mdash; Free and <a href="/demo/all?entry=open-source">open source</a>, straightforward to self-host with Docker. No ads, no data selling, no third-party analytics.</li>
    </ul>

    <h3>Explore the Demo</h3>

    <p>The sidebar is organized into sections that showcase different capabilities:</p>

    <ul>
      <li><strong>Feed Types</strong> &mdash; RSS, Atom, and JSON feeds, email newsletters, and saved articles</li>
      <li><strong>Reading Experience</strong> &mdash; Full-content fetching, AI summaries, text-to-speech, keyboard navigation, and performance</li>
      <li><strong>Organization &amp; Search</strong> &mdash; Tags and OPML import/export</li>
      <li><strong>Integrations &amp; Sync</strong> &mdash; MCP, WebSub push, the PWA, real-time updates, and compatibility APIs</li>
    </ul>

    <p>Ready to take control of your reading? Sign up to start using the full app, or <a href="https://github.com/brendanlong/lion-reader" target="_blank" rel="noopener noreferrer">check out the source code on GitHub</a> to self-host your own instance.</p>

  `,
};

export default article;
