/**
 * Demo Landing Page Data
 *
 * Static content describing Lion Reader's features,
 * structured as tags, subscriptions, and entries.
 */

import { type EntryListData } from "@/lib/hooks";

// ============================================================================
// Types
// ============================================================================

export interface DemoTag {
  id: string;
  name: string;
  color: string;
  subscriptionIds: string[];
}

export interface DemoSubscription {
  id: string;
  title: string;
  tagId: string;
  entryCount: number;
}

export interface DemoEntry extends EntryListData {
  /** Pre-sanitized HTML content for the detail view */
  contentHtml: string;
}

// ============================================================================
// Tags
// ============================================================================

export const DEMO_TAGS: DemoTag[] = [
  {
    id: "about",
    name: "About",
    color: "#10b981",
    subscriptionIds: ["lion-reader"],
  },
  {
    id: "features",
    name: "Features",
    color: "#3b82f6",
    subscriptionIds: ["feed-types", "integrations", "reading-experience"],
  },
];

// ============================================================================
// Subscriptions
// ============================================================================

export const DEMO_SUBSCRIPTIONS: DemoSubscription[] = [
  { id: "feed-types", title: "Feed Types", tagId: "features", entryCount: 4 },
  { id: "integrations", title: "Integrations", tagId: "features", entryCount: 3 },
  { id: "reading-experience", title: "Reading Experience", tagId: "features", entryCount: 4 },
  { id: "lion-reader", title: "Lion Reader", tagId: "about", entryCount: 2 },
];

// ============================================================================
// Feature implementation dates (approximate, from git history)
// ============================================================================

/** Today's date for the welcome entry */
const TODAY = new Date();

const FEATURE_DATES: Record<string, Date> = {
  "rss-atom": new Date("2025-12-26T12:00:00Z"),
  "json-feed": new Date("2025-12-26T14:00:00Z"),
  "email-newsletters": new Date("2025-12-30T12:00:00Z"),
  "save-for-later": new Date("2025-12-27T16:00:00Z"),
  "mcp-server": new Date("2026-01-14T12:00:00Z"),
  websub: new Date("2025-12-27T10:00:00Z"),
  "keyboard-shortcuts": new Date("2025-12-27T14:00:00Z"),
  "text-to-speech": new Date("2025-12-27T18:00:00Z"),
  "ai-summaries": new Date("2026-01-16T12:00:00Z"),
  "full-content": new Date("2026-01-15T12:00:00Z"),
  appearance: new Date("2025-12-28T12:00:00Z"),
  welcome: TODAY,
  "open-source": new Date("2025-12-26T10:00:00Z"),
};

// ============================================================================
// Entries
// ============================================================================

export const DEMO_ENTRIES: DemoEntry[] = [
  // --- Feed Types ---
  {
    id: "rss-atom",
    feedId: "feed-types",
    subscriptionId: "feed-types",
    type: "web",
    url: null,
    title: "RSS & Atom Feeds",
    author: null,
    summary: "Subscribe to any RSS 2.0, Atom, or JSON Feed. Lion Reader handles all the parsing.",
    publishedAt: FEATURE_DATES["rss-atom"],
    fetchedAt: FEATURE_DATES["rss-atom"],
    read: false,
    starred: false,
    feedTitle: "Feed Types",
    siteName: null,
    contentHtml: `
      <p>Lion Reader supports all major feed formats out of the box:</p>
      <ul>
        <li><strong>RSS 2.0</strong> &mdash; The most widely used feed format on the web</li>
        <li><strong>Atom</strong> &mdash; A more structured alternative to RSS</li>
        <li><strong>JSON Feed</strong> &mdash; A modern, JSON-based feed format</li>
      </ul>
      <p>Just paste a URL and Lion Reader will automatically detect the feed. It also discovers feeds from regular website URLs by checking for <code>&lt;link&gt;</code> tags in the page HTML.</p>
      <p>Feeds are fetched efficiently with proper caching headers (<code>ETag</code>, <code>If-Modified-Since</code>) so we never re-download content that hasn't changed.</p>
    `,
  },
  {
    id: "json-feed",
    feedId: "feed-types",
    subscriptionId: "feed-types",
    type: "web",
    url: null,
    title: "JSON Feed Support",
    author: null,
    summary: "Native support for the JSON Feed format, a modern alternative to XML-based feeds.",
    publishedAt: FEATURE_DATES["json-feed"],
    fetchedAt: FEATURE_DATES["json-feed"],
    read: false,
    starred: false,
    feedTitle: "Feed Types",
    siteName: null,
    contentHtml: `
      <p><a href="https://www.jsonfeed.org/" target="_blank" rel="noopener noreferrer">JSON Feed</a> is a pragmatic syndication format, like RSS and Atom, but using JSON instead of XML.</p>
      <p>Lion Reader parses JSON Feed natively, supporting:</p>
      <ul>
        <li>Version 1.0 and 1.1 specifications</li>
        <li>Attachments (podcasts, etc.)</li>
        <li>Authors and tags</li>
        <li>Content HTML and plain text</li>
      </ul>
    `,
  },
  {
    id: "email-newsletters",
    feedId: "feed-types",
    subscriptionId: "feed-types",
    type: "email",
    url: null,
    title: "Email Newsletters",
    author: null,
    summary:
      "Subscribe to newsletters with a unique email address. They appear right alongside your feeds.",
    publishedAt: FEATURE_DATES["email-newsletters"],
    fetchedAt: FEATURE_DATES["email-newsletters"],
    read: false,
    starred: false,
    feedTitle: "Feed Types",
    siteName: null,
    contentHtml: `
      <p>Many of the best writers publish via email newsletters instead of RSS feeds. Lion Reader gives you a unique ingest email address that you can subscribe to newsletters with.</p>
      <p>Newsletter emails are processed and displayed just like regular feed entries &mdash; with the same reading experience, starring, and organization features.</p>
      <p>Each newsletter gets its own subscription that you can organize with tags, just like RSS feeds.</p>
    `,
  },
  {
    id: "save-for-later",
    feedId: "feed-types",
    subscriptionId: "feed-types",
    type: "saved",
    url: null,
    title: "Save for Later",
    author: null,
    summary: "Save any web page for later reading with the bookmarklet or API.",
    publishedAt: FEATURE_DATES["save-for-later"],
    fetchedAt: FEATURE_DATES["save-for-later"],
    read: false,
    starred: false,
    feedTitle: "Feed Types",
    siteName: null,
    contentHtml: `
      <p>Save any article from the web to read later. Lion Reader fetches the full content and displays it in a clean reading view.</p>
      <p>You can save articles using:</p>
      <ul>
        <li><strong>Bookmarklet</strong> &mdash; Drag a button to your bookmarks bar for one-click saving</li>
        <li><strong>API</strong> &mdash; Use the tRPC or REST API to save articles programmatically</li>
        <li><strong>MCP</strong> &mdash; Save articles through AI assistants that support MCP</li>
      </ul>
      <p>Saved articles appear in their own section and can be starred and organized alongside your regular feeds.</p>
    `,
  },

  // --- Integrations ---
  {
    id: "mcp-server",
    feedId: "integrations",
    subscriptionId: "integrations",
    type: "web",
    url: null,
    title: "MCP Server",
    author: null,
    summary: "Control Lion Reader from AI assistants like Claude using the Model Context Protocol.",
    publishedAt: FEATURE_DATES["mcp-server"],
    fetchedAt: FEATURE_DATES["mcp-server"],
    read: false,
    starred: false,
    feedTitle: "Integrations",
    siteName: null,
    contentHtml: `
      <p>Lion Reader includes a built-in <a href="https://modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer">Model Context Protocol (MCP)</a> server that lets AI assistants interact with your feeds.</p>
      <p>With MCP, your AI assistant can:</p>
      <ul>
        <li>List and search your subscriptions</li>
        <li>Read entry content and summaries</li>
        <li>Mark entries as read or starred</li>
        <li>Save articles for later reading</li>
        <li>Search across all your entries</li>
      </ul>
      <p>Set it up by adding Lion Reader to your AI assistant&rsquo;s MCP configuration. It uses stdio transport for secure local communication.</p>
    `,
  },
  {
    id: "websub",
    feedId: "integrations",
    subscriptionId: "integrations",
    type: "web",
    url: null,
    title: "WebSub Push Notifications",
    author: null,
    summary: "Instant updates via WebSub (PubSubHubbub) for feeds that support push delivery.",
    publishedAt: FEATURE_DATES["websub"],
    fetchedAt: FEATURE_DATES["websub"],
    read: false,
    starred: false,
    feedTitle: "Integrations",
    siteName: null,
    contentHtml: `
      <p><a href="https://www.w3.org/TR/websub/" target="_blank" rel="noopener noreferrer">WebSub</a> is a W3C standard for real-time content delivery. When a feed supports WebSub, Lion Reader subscribes for push notifications instead of polling.</p>
      <p>This means:</p>
      <ul>
        <li><strong>Instant updates</strong> &mdash; New entries appear within seconds of publication</li>
        <li><strong>Reduced load</strong> &mdash; No unnecessary polling requests to the feed server</li>
        <li><strong>Better for publishers</strong> &mdash; Less bandwidth used by feed readers</li>
      </ul>
      <p>WebSub is automatically detected and used when available. No configuration needed.</p>
    `,
  },
  {
    id: "keyboard-shortcuts",
    feedId: "integrations",
    subscriptionId: "integrations",
    type: "web",
    url: null,
    title: "Keyboard Shortcuts",
    author: null,
    summary: "Navigate and manage entries entirely from the keyboard for a fast reading workflow.",
    publishedAt: FEATURE_DATES["keyboard-shortcuts"],
    fetchedAt: FEATURE_DATES["keyboard-shortcuts"],
    read: false,
    starred: false,
    feedTitle: "Integrations",
    siteName: null,
    contentHtml: `
      <p>Power through your reading list with keyboard shortcuts:</p>
      <ul>
        <li><kbd>j</kbd> / <kbd>k</kbd> &mdash; Navigate between entries</li>
        <li><kbd>Enter</kbd> &mdash; Open selected entry</li>
        <li><kbd>Escape</kbd> &mdash; Go back to entry list</li>
        <li><kbd>m</kbd> &mdash; Toggle read/unread</li>
        <li><kbd>s</kbd> &mdash; Toggle starred</li>
        <li><kbd>v</kbd> &mdash; Open entry URL in new tab</li>
      </ul>
      <p>Shortcuts work throughout the app and respect focus state, so they won&rsquo;t interfere with text input fields.</p>
    `,
  },

  // --- Reading Experience ---
  {
    id: "text-to-speech",
    feedId: "reading-experience",
    subscriptionId: "reading-experience",
    type: "web",
    url: null,
    title: "Text-to-Speech Narration",
    author: null,
    summary:
      "Listen to articles with natural-sounding text-to-speech, with paragraph highlighting.",
    publishedAt: FEATURE_DATES["text-to-speech"],
    fetchedAt: FEATURE_DATES["text-to-speech"],
    read: false,
    starred: false,
    feedTitle: "Reading Experience",
    siteName: null,
    contentHtml: `
      <p>Turn any article into an audio experience. Lion Reader&rsquo;s narration feature reads articles aloud with natural-sounding speech.</p>
      <p>Features include:</p>
      <ul>
        <li><strong>Paragraph highlighting</strong> &mdash; Follow along as each paragraph is read</li>
        <li><strong>Auto-scroll</strong> &mdash; The view scrolls to keep the current paragraph visible</li>
        <li><strong>Speed control</strong> &mdash; Adjust playback speed to your preference</li>
        <li><strong>Multiple voices</strong> &mdash; Choose from several voice options</li>
        <li><strong>Media controls</strong> &mdash; Play/pause from your lock screen or notification shade</li>
      </ul>
      <p>Great for multitasking or when you prefer listening to reading.</p>
    `,
  },
  {
    id: "ai-summaries",
    feedId: "reading-experience",
    subscriptionId: "reading-experience",
    type: "web",
    url: null,
    title: "AI Summaries",
    author: null,
    summary:
      "Get AI-generated summaries to quickly decide which articles are worth reading in full.",
    publishedAt: FEATURE_DATES["ai-summaries"],
    fetchedAt: FEATURE_DATES["ai-summaries"],
    read: false,
    starred: false,
    feedTitle: "Reading Experience",
    siteName: null,
    contentHtml: `
      <p>Not sure if an article is worth your time? Generate an AI summary with one click to get the key points.</p>
      <p>Summaries are:</p>
      <ul>
        <li><strong>On-demand</strong> &mdash; Only generated when you ask, respecting your privacy</li>
        <li><strong>Cached</strong> &mdash; Generated once and stored so they load instantly on repeat views</li>
        <li><strong>Configurable</strong> &mdash; Choose your preferred AI model in settings</li>
      </ul>
      <p>Summaries appear in a card above the article content, so you can glance at the summary and decide whether to read the full article.</p>
    `,
  },
  {
    id: "full-content",
    feedId: "reading-experience",
    subscriptionId: "reading-experience",
    type: "web",
    url: null,
    title: "Full Content Fetching",
    author: null,
    summary: "Fetch full article content even when feeds only provide excerpts or summaries.",
    publishedAt: FEATURE_DATES["full-content"],
    fetchedAt: FEATURE_DATES["full-content"],
    read: false,
    starred: false,
    feedTitle: "Reading Experience",
    siteName: null,
    contentHtml: `
      <p>Many feeds only include a brief excerpt. Lion Reader can fetch the full article content directly from the source URL.</p>
      <p>Full content fetching:</p>
      <ul>
        <li>Uses Mozilla&rsquo;s Readability algorithm to extract clean article text</li>
        <li>Can be enabled per-subscription for feeds that consistently provide excerpts</li>
        <li>Falls back to the feed content if extraction fails</li>
        <li>Preserves images, code blocks, and formatting</li>
      </ul>
      <p>Toggle between the feed content and full content with a single button press.</p>
    `,
  },
  {
    id: "appearance",
    feedId: "reading-experience",
    subscriptionId: "reading-experience",
    type: "web",
    url: null,
    title: "Appearance & Themes",
    author: null,
    summary: "Customize your reading experience with fonts, text sizes, and dark mode.",
    publishedAt: FEATURE_DATES["appearance"],
    fetchedAt: FEATURE_DATES["appearance"],
    read: false,
    starred: false,
    feedTitle: "Reading Experience",
    siteName: null,
    contentHtml: `
      <p>Make Lion Reader feel like your own with customizable appearance settings:</p>
      <ul>
        <li><strong>Font family</strong> &mdash; Choose from system, serif (Merriweather, Literata), or sans-serif (Inter, Source Sans) fonts</li>
        <li><strong>Text size</strong> &mdash; Small, medium, large, or extra-large</li>
        <li><strong>Text alignment</strong> &mdash; Left-aligned or justified</li>
        <li><strong>Dark mode</strong> &mdash; Full dark theme support, following your system preference or set manually</li>
      </ul>
      <p>Settings are saved locally and apply instantly across all articles.</p>
    `,
  },

  // --- About / Lion Reader ---
  {
    id: "welcome",
    feedId: "lion-reader",
    subscriptionId: "lion-reader",
    type: "web",
    url: null,
    title: "Welcome to Lion Reader",
    author: null,
    summary: "A modern, fast, and open-source feed reader. Explore the demo to see what it can do.",
    publishedAt: FEATURE_DATES["welcome"],
    fetchedAt: FEATURE_DATES["welcome"],
    read: false,
    starred: true,
    feedTitle: "Lion Reader",
    siteName: null,
    contentHtml: `
      <p>Welcome to <strong>Lion Reader</strong>, a modern feed reader built for people who value their reading experience.</p>
      <p>This interactive demo shows you what Lion Reader looks like in action. Browse the sidebar to explore features, or click on entries to read more about each one.</p>
      <h3>Highlights</h3>
      <ul>
        <li><strong>All your content in one place</strong> &mdash; RSS, Atom, JSON Feed, email newsletters, and saved articles</li>
        <li><strong>AI-powered features</strong> &mdash; Summaries, text-to-speech narration, and MCP integration</li>
        <li><strong>Keyboard-first design</strong> &mdash; Navigate everything without touching your mouse</li>
        <li><strong>Privacy-focused</strong> &mdash; Self-hostable, open source, no tracking</li>
      </ul>
      <p>Click around the sidebar to learn about specific features, or sign up to start using Lion Reader today.</p>
    `,
  },
  {
    id: "open-source",
    feedId: "lion-reader",
    subscriptionId: "lion-reader",
    type: "web",
    url: "https://github.com/brendanlong/lion-reader",
    title: "Open Source",
    author: null,
    summary: "Lion Reader is fully open source. Self-host it or contribute on GitHub.",
    publishedAt: FEATURE_DATES["open-source"],
    fetchedAt: FEATURE_DATES["open-source"],
    read: false,
    starred: false,
    feedTitle: "Lion Reader",
    siteName: null,
    contentHtml: `
      <p>Lion Reader is fully open source and designed to be self-hosted. You own your data and your reading experience.</p>
      <h3>Tech Stack</h3>
      <ul>
        <li><strong>Next.js</strong> &mdash; React framework with server-side rendering</li>
        <li><strong>tRPC</strong> &mdash; End-to-end typesafe APIs</li>
        <li><strong>PostgreSQL</strong> &mdash; Reliable data storage with full-text search</li>
        <li><strong>Redis</strong> &mdash; Caching, real-time updates via SSE, and rate limiting</li>
        <li><strong>Drizzle ORM</strong> &mdash; Type-safe database queries</li>
      </ul>
      <h3>Contributing</h3>
      <p>Contributions are welcome! Check out the repository for setup instructions, architecture docs, and open issues.</p>
    `,
  },
];

// ============================================================================
// Lookup helpers
// ============================================================================

const entriesBySubscription = new Map<string, DemoEntry[]>();
for (const entry of DEMO_ENTRIES) {
  const subId = entry.subscriptionId!;
  const existing = entriesBySubscription.get(subId) ?? [];
  existing.push(entry);
  entriesBySubscription.set(subId, existing);
}

const entriesById = new Map<string, DemoEntry>();
for (const entry of DEMO_ENTRIES) {
  entriesById.set(entry.id, entry);
}

const subscriptionsById = new Map<string, DemoSubscription>();
for (const sub of DEMO_SUBSCRIPTIONS) {
  subscriptionsById.set(sub.id, sub);
}

export function getDemoEntriesForSubscription(subscriptionId: string): DemoEntry[] {
  return entriesBySubscription.get(subscriptionId) ?? [];
}

/** Get entries for a tag (entries from all subscriptions in that tag) */
export function getDemoEntriesForTag(tagId: string): DemoEntry[] {
  const tag = DEMO_TAGS.find((t) => t.id === tagId);
  if (!tag) return [];
  const subIds = new Set(tag.subscriptionIds);
  return DEMO_ENTRIES.filter((e) => e.subscriptionId && subIds.has(e.subscriptionId));
}

export function getDemoTag(tagId: string): DemoTag | undefined {
  return DEMO_TAGS.find((t) => t.id === tagId);
}

export function getDemoEntry(entryId: string): DemoEntry | undefined {
  return entriesById.get(entryId);
}

export function getDemoSubscription(subscriptionId: string): DemoSubscription | undefined {
  return subscriptionsById.get(subscriptionId);
}

/** Get entries that would appear in the "Highlights" view (starred entries) */
export function getDemoHighlightEntries(): DemoEntry[] {
  return DEMO_ENTRIES.filter((e) => e.starred);
}

/** Total entry count */
export const DEMO_TOTAL_COUNT = DEMO_ENTRIES.length;
