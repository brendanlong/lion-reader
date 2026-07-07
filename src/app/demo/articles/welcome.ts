import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "welcome",
  subscriptionId: "lion-reader",
  type: "web",
  url: null,
  title: "Welcome to Lion Reader",
  author: null,
  summary:
    "An AI-native, all-in-one reader for feeds, newsletters, and read-later. Explore the demo to see what it can do.",
  publishedAt: new Date(),
  starred: true,
  heroImage: "/demo/welcome.png",
  heroImageAlt:
    "The Lion Reader lion waving hello, surrounded by feature motifs: a newspaper, a book with a bookmark, an email envelope, and a friendly robot.",
  summaryHtml: `<p><strong>Lion Reader</strong> is an AI-native, self-hostable reader that unifies RSS/Atom/JSON feeds, email newsletters, and saved articles in one fast interface. It connects to AI assistants over <strong>MCP</strong>, generates on-demand <strong>summaries</strong> via Claude, and narrates articles with synchronized highlighting &mdash; all with real-time, jank-free updates. Free and open source.</p>`,
  contentHtml: `
    <p>Lion Reader is a self-hostable feed reader for people who take their reading seriously. It brings your feeds, your newsletters, and everything you save for later into one fast, elegant interface &mdash; and it&rsquo;s built from the ground up to work with AI assistants.</p>

    <p>This interactive demo is the real Lion Reader UI. Browse the sidebar to explore each capability; everything here behaves exactly like the production app.</p>

    <h3>What makes it different</h3>

    <ul>
      <li><strong>AI-native, not AI-bolted-on</strong> &mdash; Connect Claude and other assistants directly to your reader over the <strong>Model Context Protocol (MCP)</strong> to search, organize, save, and triage on your behalf. Generate concise article <strong>summaries</strong> on demand (never auto-summarized behind your back), and listen to any article with <strong>text-to-speech narration and synchronized highlighting</strong>.</li>
      <li><strong>Everything in one place</strong> &mdash; Subscribe to RSS, Atom, and JSON feeds; receive <strong>email newsletters</strong> at a private ingest address; and save any page for later with browser extensions, a bookmarklet, a Discord bot, your phone&rsquo;s share menu, or Markdown/Word uploads. Saving is extra-smart for arXiv, GitHub, Google Docs, and LessWrong.</li>
      <li><strong>Obsessively fast</strong> &mdash; New entries show up in the list you&rsquo;re reading without a refresh and without disturbing your place, and moving around the app is instant &mdash; served straight from cache wherever possible, with nothing else reloading. See the <strong>Obsessive Performance</strong> article for how.</li>
      <li><strong>All the essentials, done well</strong> &mdash; Full-content fetching, tags, full-text search, keyboard-first navigation, OPML import/export, an installable PWA, and clean modern styling with light and dark themes.</li>
      <li><strong>Yours to own</strong> &mdash; Free and open source, straightforward to self-host with Docker. No ads, no data selling, no third-party analytics.</li>
    </ul>

    <h3>Explore the Demo</h3>

    <p>The sidebar is organized into sections that showcase different capabilities:</p>

    <ul>
      <li><strong>Feed Types</strong> &mdash; RSS, Atom, and JSON feeds, email newsletters, and saved articles</li>
      <li><strong>Reading Experience</strong> &mdash; Full-content fetching, AI summaries, text-to-speech, keyboard navigation, and performance</li>
      <li><strong>Organization &amp; Search</strong> &mdash; Tags, full-text search, and OPML import/export</li>
      <li><strong>Integrations &amp; Sync</strong> &mdash; MCP, WebSub push, the PWA, real-time updates, and compatibility APIs</li>
    </ul>

    <p>Ready to take control of your reading? Sign up to start using the full app, or <a href="https://github.com/brendanlong/lion-reader" target="_blank" rel="noopener noreferrer">check out the source code on GitHub</a> to self-host your own instance.</p>

  `,
};

export default article;
