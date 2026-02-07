/**
 * Demo Landing Page Data
 *
 * Static content describing Lion Reader's features,
 * structured as tags, subscriptions, and entries.
 */

import { type EntryArticleProps } from "@/components/entries/EntryArticle";
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
    subscriptionIds: ["feed-types", "reading-experience", "organization", "integrations"],
  },
];

// ============================================================================
// Subscriptions
// ============================================================================

export const DEMO_SUBSCRIPTIONS: DemoSubscription[] = [
  { id: "feed-types", title: "Feed Types", tagId: "features", entryCount: 4 },
  { id: "reading-experience", title: "Reading Experience", tagId: "features", entryCount: 5 },
  { id: "organization", title: "Organization & Search", tagId: "features", entryCount: 4 },
  { id: "integrations", title: "Integrations & Sync", tagId: "features", entryCount: 4 },
  { id: "lion-reader", title: "Lion Reader", tagId: "about", entryCount: 3 },
];

// ============================================================================
// Feature implementation dates (approximate, from git history)
// ============================================================================

/** Today's date for the welcome entry */
const TODAY = new Date();

const FEATURE_DATES: Record<string, Date> = {
  // Feed Types
  "rss-atom": new Date("2025-12-26T12:00:00Z"),
  "json-feed": new Date("2025-12-26T14:00:00Z"),
  "email-newsletters": new Date("2025-12-30T12:00:00Z"),
  "save-for-later": new Date("2025-12-27T16:00:00Z"),
  // Reading Experience
  "full-content": new Date("2026-01-15T12:00:00Z"),
  appearance: new Date("2025-12-28T12:00:00Z"),
  "text-to-speech": new Date("2025-12-27T18:00:00Z"),
  "ai-summaries": new Date("2026-01-16T12:00:00Z"),
  "keyboard-shortcuts": new Date("2025-12-27T14:00:00Z"),
  // Organization & Search
  tags: new Date("2025-12-27T10:00:00Z"),
  search: new Date("2025-12-28T10:00:00Z"),
  scoring: new Date("2026-01-20T12:00:00Z"),
  opml: new Date("2025-12-28T14:00:00Z"),
  // Integrations & Sync
  "mcp-server": new Date("2026-01-14T12:00:00Z"),
  websub: new Date("2025-12-27T10:00:00Z"),
  pwa: new Date("2026-01-08T12:00:00Z"),
  "real-time": new Date("2025-12-28T16:00:00Z"),
  // About
  welcome: TODAY,
  "open-source": new Date("2025-12-26T10:00:00Z"),
  "auth-security": new Date("2025-12-26T11:00:00Z"),
};

// ============================================================================
// Entries
// ============================================================================

export const DEMO_ENTRIES: DemoEntry[] = [
  // -------------------------------------------------------------------------
  // Feed Types
  // -------------------------------------------------------------------------
  {
    id: "rss-atom",
    feedId: "feed-types",
    subscriptionId: "feed-types",
    type: "web",
    url: null,
    title: "RSS & Atom Feeds",
    author: null,
    summary:
      "Subscribe to any RSS 2.0 or Atom feed with automatic detection and efficient polling.",
    publishedAt: FEATURE_DATES["rss-atom"],
    fetchedAt: FEATURE_DATES["rss-atom"],
    read: false,
    starred: false,
    feedTitle: "Feed Types",
    siteName: null,
    contentHtml: `
      <h2>Modern Syndication with RSS &amp; Atom</h2>

      <p>Lion Reader supports all major web feed formats: RSS 2.0, Atom 1.0, and JSON Feed. RSS (Really Simple Syndication) and Atom are XML-based syndication formats that allow you to subscribe to websites and receive updates automatically. Simply paste any URL and Lion Reader will discover available feeds by checking HTML <code>&lt;link&gt;</code> tags and common feed paths like <code>/feed</code>, <code>/rss</code>, and <code>/atom.xml</code>. You can preview the feed&rsquo;s title, description, and sample entries before subscribing.</p>

      <h3>Efficient Polling &amp; Smart Scheduling</h3>

      <p>Lion Reader uses HTTP conditional requests to avoid wasting bandwidth on unchanged content. When checking for updates, it sends <code>ETag</code>, <code>If-Modified-Since</code>, and <code>If-None-Match</code> headers so servers can respond with a lightweight 304 Not Modified status if nothing has changed. The polling schedule respects <code>Cache-Control</code> headers from the server while enforcing reasonable bounds: feeds are checked between once per minute and once every 7 days.</p>

      <h3>Graceful Error Handling</h3>

      <p>Lion Reader handles HTTP redirects intelligently: it tracks 301 permanent redirects and updates the feed URL after 3 confirmations, while following 302 and 307 temporary redirects without updating the stored URL. If a feed fails to fetch, exponential backoff is applied with a maximum retry interval of 7 days. This approach ensures Lion Reader is a good citizen of the web while keeping your feeds up to date.</p>

      <h3>Fast &amp; Memory-Efficient Parsing</h3>

      <p>All feeds are parsed using <code>fast-xml-parser</code> in SAX (streaming) mode, which provides excellent performance and low memory usage even for large feeds. This architectural choice allows Lion Reader to handle feeds of any size efficiently.</p>

      <ul>
        <li><a href="https://www.rssboard.org/rss-specification" target="_blank" rel="noopener noreferrer">RSS 2.0 Specification</a></li>
        <li><a href="https://www.rfc-editor.org/rfc/rfc4287" target="_blank" rel="noopener noreferrer">Atom 1.0 Specification (RFC 4287)</a></li>
      </ul>
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
    summary:
      "Native support for JSON Feed, a modern syndication format that uses JSON instead of XML.",
    publishedAt: FEATURE_DATES["json-feed"],
    fetchedAt: FEATURE_DATES["json-feed"],
    read: false,
    starred: false,
    feedTitle: "Feed Types",
    siteName: null,
    contentHtml: `
      <h2>JSON Feed: Syndication for the Modern Web</h2>

      <p>JSON Feed is a modern syndication format that uses JSON instead of XML, making it dramatically easier to produce and consume programmatically. Launched in 2017 as a simpler alternative to RSS and Atom, JSON Feed was designed with modern web development practices in mind. Lion Reader provides full native support for JSON Feed versions 1.0 and 1.1, treating it as a first-class citizen alongside RSS and Atom.</p>

      <h3>Why JSON Feed?</h3>

      <p>If you&rsquo;ve ever worked with XML parsing, you know the pain: verbose schemas, namespace handling, and complex parsing libraries. JSON Feed eliminates this complexity by using a format that JavaScript developers already know and love. It supports everything you need from a modern feed: attachments, multiple authors, tags, both HTML and plain text content, and extensibility through custom fields. Lion Reader auto-detects JSON Feed just like RSS and Atom feeds, so subscribing is as simple as pasting any URL.</p>

      <h3>Developer-Friendly Syndication</h3>

      <p>For content creators and developers building publishing platforms, JSON Feed is a breath of fresh air. You can generate a valid feed using nothing more than your language&rsquo;s built-in JSON encoder &mdash; no XML libraries required. For readers like Lion Reader, parsing is trivial: deserialize JSON, validate the structure, done. This simplicity reduces bugs and makes the entire syndication ecosystem more reliable.</p>

      <ul>
        <li><a href="https://www.jsonfeed.org/" target="_blank" rel="noopener noreferrer">JSON Feed Official Site</a></li>
        <li><a href="https://www.jsonfeed.org/version/1.1/" target="_blank" rel="noopener noreferrer">JSON Feed Version 1.1 Specification</a></li>
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
    summary: "Read newsletters alongside your feeds with unique ingest email addresses.",
    publishedAt: FEATURE_DATES["email-newsletters"],
    fetchedAt: FEATURE_DATES["email-newsletters"],
    read: false,
    starred: false,
    feedTitle: "Feed Types",
    siteName: null,
    contentHtml: `
      <h2>Email Newsletters: Bring Inbox Content to Your Feed Reader</h2>

      <p>Many exceptional writers and publications distribute content exclusively via email newsletters, not RSS feeds. Substack, Ghost, Buttondown, and countless independent creators have chosen email as their primary distribution channel. Lion Reader solves this problem by generating unique ingest email addresses &mdash; up to 5 per account &mdash; that you can use to subscribe to any newsletter. Each newsletter sender automatically becomes its own subscription in your Lion Reader account, appearing alongside your web feeds in a unified timeline.</p>

      <h3>How It Works</h3>

      <p>When you create an ingest address, you can label it for organization (e.g., &ldquo;Tech Newsletters&rdquo; or &ldquo;Personal&rdquo;). Subscribe to newsletters using this address just like you would with your regular email. When newsletters arrive, Lion Reader processes them via Mailgun webhook integration, verifies HMAC signatures for security, deduplicates by Message-ID, and converts the content into regular feed entries with a full reading experience. You can star entries, mark them read, search across content, and organize them with tags &mdash; everything you can do with RSS feeds.</p>

      <h3>Security &amp; Spam Protection</h3>

      <p>Ingest addresses include built-in security measures: HMAC signature verification ensures emails are genuinely from the mail provider, Message-ID deduplication prevents duplicates, and provider-level spam filtering blocks junk before it reaches your feed. You can block specific senders at any time, and Lion Reader respects List-Unsubscribe headers for one-click unsubscribe functionality when newsletters support it.</p>

      <p>Email newsletters in Lion Reader are treated as first-class subscriptions &mdash; they appear in your timeline, support all the same reading features as RSS feeds, and can be organized with the same tools. No more switching between your email client and feed reader to keep up with your favorite writers.</p>
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
    summary: "Save any web page, upload documents, or capture articles for later reading.",
    publishedAt: FEATURE_DATES["save-for-later"],
    fetchedAt: FEATURE_DATES["save-for-later"],
    read: false,
    starred: false,
    feedTitle: "Feed Types",
    siteName: null,
    contentHtml: `
      <h2>Save for Later: Your Personal Reading Archive</h2>

      <p>Lion Reader&rsquo;s Save for Later feature transforms any web page, document, or article into a clean, distraction-free reading experience. Using Mozilla&rsquo;s battle-tested <a href="https://github.com/mozilla/readability" target="_blank" rel="noopener noreferrer">Readability algorithm</a> &mdash; the same technology behind Firefox Reader View &mdash; Lion Reader extracts the main content from cluttered web pages, removes ads and navigation chrome, and presents you with a beautifully formatted article ready for focused reading.</p>

      <h3>Multiple Ways to Save</h3>

      <p>Lion Reader offers flexibility in how you capture content for later reading:</p>

      <ul>
        <li><strong>Browser bookmarklet</strong> &mdash; One-click saving from any page while browsing</li>
        <li><strong>PWA share target</strong> &mdash; Use your phone&rsquo;s native share menu to send articles directly to Lion Reader</li>
        <li><strong>MCP integration</strong> &mdash; Save articles via AI assistants like Claude</li>
        <li><strong>tRPC API</strong> &mdash; Programmatic saving for automation and integrations</li>
        <li><strong>Discord bot</strong> &mdash; Save articles via Discord commands</li>
        <li><strong>File upload</strong> &mdash; Upload PDFs, Markdown files, Word documents, and other file types directly</li>
        <li><strong>Google Docs import</strong> &mdash; Import Google Docs directly with the optional OAuth scope</li>
      </ul>

      <h3>Custom Metadata &amp; Organization</h3>

      <p>When saving articles, you can set custom metadata including title, description, and author &mdash; perfect for adding context or fixing incorrect extraction. Saved articles appear in a dedicated &ldquo;Saved&rdquo; section in your sidebar, but they&rsquo;re fully integrated with the rest of Lion Reader: star important articles, tag them for organization, search across saved content, and browse your reading archive chronologically. Unlike traditional bookmarks that rot over time as pages disappear, your saved articles are preserved with full content extraction, ensuring your reading list remains accessible indefinitely.</p>
    `,
  },

  // -------------------------------------------------------------------------
  // Reading Experience
  // -------------------------------------------------------------------------
  {
    id: "full-content",
    feedId: "reading-experience",
    subscriptionId: "reading-experience",
    type: "web",
    url: null,
    title: "Full Content Fetching",
    author: null,
    summary: "Read complete articles inside Lion Reader, even when feeds only provide excerpts.",
    publishedAt: FEATURE_DATES["full-content"],
    fetchedAt: FEATURE_DATES["full-content"],
    read: false,
    starred: false,
    feedTitle: "Reading Experience",
    siteName: null,
    contentHtml: `
      <h2>Full Content Fetching</h2>

      <p>Many RSS feeds only provide excerpts or summaries, forcing you to leave your feed reader to read the full article in a web browser. This constant context switching breaks your reading flow and makes it harder to stay focused on what matters.</p>

      <p>Lion Reader solves this problem by fetching the full article content on demand. When a feed only includes a summary, you can fetch the complete article with a single button press. The full content appears right in your reading interface, keeping you focused and in the flow.</p>

      <h3>How It Works</h3>

      <p>Under the hood, Lion Reader uses <a href="https://github.com/mozilla/readability" target="_blank" rel="noopener noreferrer">Mozilla&rsquo;s Readability algorithm</a> &mdash; the same technology that powers Firefox Reader View &mdash; to extract clean article text from web pages. The algorithm intelligently identifies the main content while stripping away ads, navigation bars, and other distractions.</p>

      <p>You can enable automatic full-content fetching per subscription for feeds that consistently truncate their articles. Or use the manual toggle to switch between feed content and full content whenever you need it. The system preserves images, code blocks, formatting, and document structure so you get an authentic reading experience. If extraction fails for any reason, Lion Reader gracefully falls back to displaying the original feed content.</p>

      <p>For Markdown-formatted content, Lion Reader uses the marked library to convert Markdown to clean HTML, preserving code blocks, tables, and all standard Markdown formatting.</p>
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
    summary: "Customize fonts, text size, alignment, and switch between light and dark themes.",
    publishedAt: FEATURE_DATES["appearance"],
    fetchedAt: FEATURE_DATES["appearance"],
    read: false,
    starred: false,
    feedTitle: "Reading Experience",
    siteName: null,
    contentHtml: `
      <h2>Appearance &amp; Themes</h2>

      <p>Reading comfort is personal. What works for one person might strain another&rsquo;s eyes. That&rsquo;s why Lion Reader gives you comprehensive control over how your content appears, letting you create the perfect reading environment for your preferences and lighting conditions.</p>

      <h3>Dark Mode</h3>

      <p>Full dark mode support comes powered by <a href="https://github.com/pacocoursey/next-themes" target="_blank" rel="noopener noreferrer">next-themes</a>. You can follow your system&rsquo;s light/dark preference or manually toggle between modes. Every component, from the sidebar to article content, adapts seamlessly to your chosen theme.</p>

      <h3>Typography Controls</h3>

      <p>Fine-tune your reading experience with multiple font families to choose from:</p>

      <ul>
        <li><strong>System</strong> &mdash; Uses your operating system&rsquo;s default font</li>
        <li><strong>Serif options</strong> &mdash; Merriweather and Literata for traditional book-like reading</li>
        <li><strong>Sans-serif options</strong> &mdash; Inter and Source Sans for modern, clean typography</li>
      </ul>

      <p>Text size options range from small to extra-large, with responsive scaling across all screen sizes. Choose left-aligned or justified text alignment based on your preference. All settings save locally and apply instantly as you adjust them.</p>

      <h3>Progressive Web App</h3>

      <p>Lion Reader is a Progressive Web App, which means you can install it on your desktop or mobile device for a native app-like experience. On mobile, the app locks to portrait orientation for optimal reading comfort. The demo page you&rsquo;re viewing right now showcases the reading experience with all these customization options available.</p>
    `,
  },
  {
    id: "text-to-speech",
    feedId: "reading-experience",
    subscriptionId: "reading-experience",
    type: "web",
    url: null,
    title: "Text-to-Speech Narration",
    author: null,
    summary:
      "Listen to articles read aloud with AI-enhanced text preprocessing and paragraph highlighting.",
    publishedAt: FEATURE_DATES["text-to-speech"],
    fetchedAt: FEATURE_DATES["text-to-speech"],
    read: false,
    starred: false,
    feedTitle: "Reading Experience",
    siteName: null,
    contentHtml: `
      <h2>Text-to-Speech Narration</h2>

      <p>Sometimes you want to listen instead of read &mdash; while cooking, commuting, or just giving your eyes a rest. Lion Reader&rsquo;s narration feature transforms articles into natural-sounding audio using a two-stage pipeline that combines AI preprocessing with on-device speech synthesis.</p>

      <h3>Stage 1: AI Text Preprocessing</h3>

      <p>Raw article HTML isn&rsquo;t ready for text-to-speech. Abbreviations like &ldquo;Dr.&rdquo; get mispronounced, URLs sound terrible when read aloud, and technical notation confuses speech engines. To solve this, Lion Reader first sends article content through an LLM (Llama 3.1 via <a href="https://groq.com/" target="_blank" rel="noopener noreferrer">Groq</a>) that transforms the text for natural narration.</p>

      <p>The AI expands abbreviations (&ldquo;Dr.&rdquo; becomes &ldquo;Doctor&rdquo;), converts URLs to readable phrases, formats lists and tables as natural language, and handles code blocks with clear verbal markers. Crucially, it maintains paragraph-level mapping so the app can synchronize highlighting as the audio plays. This preprocessing is cached by content hash, so the same article is only processed once &mdash; even if multiple users narrate it.</p>

      <h3>Stage 2: Audio Synthesis</h3>

      <p>After preprocessing, you can choose between two synthesis options. The Web Speech API uses your browser&rsquo;s built-in voices for instant, zero-cost narration. Or enable <a href="https://github.com/rhasspy/piper" target="_blank" rel="noopener noreferrer">Piper TTS</a> for higher-quality neural voice synthesis powered by ONNX Runtime WebAssembly running locally in your browser &mdash; no server required, no per-character fees.</p>

      <h3>Reading Along</h3>

      <p>As narration plays, Lion Reader highlights each paragraph in sync with the audio and automatically scrolls to keep the current paragraph visible. You can control playback speed, skip forward or backward by paragraph, and use media session integration to control narration from your lock screen or notification shade. If the LLM service is unavailable, the system gracefully falls back to plain text narration so you can always listen to your articles.</p>
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
    summary: "Generate concise AI summaries to quickly triage your reading list.",
    publishedAt: FEATURE_DATES["ai-summaries"],
    fetchedAt: FEATURE_DATES["ai-summaries"],
    read: false,
    starred: false,
    feedTitle: "Reading Experience",
    siteName: null,
    contentHtml: `
      <h2>AI Summaries</h2>

      <p>A busy morning can leave you with dozens of unread articles. Which ones are worth your time? AI summaries help you triage your reading list by generating concise overviews on demand, letting you quickly decide what deserves your full attention.</p>

      <h3>Privacy-Respecting Design</h3>

      <p>Unlike some readers that automatically summarize everything (consuming API credits and sharing your reading habits), Lion Reader only generates summaries when you explicitly request them. Click the &ldquo;Summarize&rdquo; button in the article header, and <a href="https://www.anthropic.com/" target="_blank" rel="noopener noreferrer">Anthropic Claude</a> generates a 2&ndash;3 paragraph overview focusing on the main topic, key findings, and important conclusions.</p>

      <p>The summary appears in a collapsible card above the article content. You can expand or collapse it as needed, or dismiss it entirely if you decide to read the full article instead.</p>

      <h3>Efficient Caching</h3>

      <p>Summaries are cached by content hash and shared across all users. If someone else already summarized an article, you get the cached result instantly &mdash; no API call required. This aggressive caching dramatically reduces costs while speeding up response times. You can configure your preferred summarization model in settings, balancing quality and speed based on your needs.</p>

      <h3>Works Everywhere</h3>

      <p>Summaries work with both feed content and full-fetched content. If a feed only provides an excerpt, fetch the full article first, then summarize &mdash; ensuring you get a summary of the complete text, not just the preview. The feature gracefully degrades when the AI service is unavailable, displaying a clear error message rather than leaving you wondering what happened.</p>

      <p>Great for working through a large backlog: quickly scan summaries to separate the must-reads from the can-skip, then dive deep into the articles that matter most to you.</p>
    `,
  },
  {
    id: "keyboard-shortcuts",
    feedId: "reading-experience",
    subscriptionId: "reading-experience",
    type: "web",
    url: null,
    title: "Keyboard Shortcuts",
    author: null,
    summary: "Navigate your entire reading workflow without touching the mouse.",
    publishedAt: FEATURE_DATES["keyboard-shortcuts"],
    fetchedAt: FEATURE_DATES["keyboard-shortcuts"],
    read: false,
    starred: false,
    feedTitle: "Reading Experience",
    siteName: null,
    contentHtml: `
      <h2>Keyboard Shortcuts</h2>

      <p>Mouse or touch interfaces work fine, but keyboard navigation is faster once you learn it. Lion Reader follows a keyboard-first design philosophy inspired by Vim, giving every core action a keyboard shortcut so you can blaze through your reading workflow without touching the mouse.</p>

      <h3>List Navigation</h3>

      <p>Navigate your entry list with <kbd>j</kbd> and <kbd>k</kbd> to move down and up respectively. Press <kbd>Enter</kbd> to open the selected entry. Once you&rsquo;re reading, <kbd>n</kbd> and <kbd>p</kbd> jump to the next and previous articles. Hit <kbd>Escape</kbd> to close the article and return to the list.</p>

      <h3>Entry Actions</h3>

      <p>Manage entries without leaving the keyboard. Press <kbd>m</kbd> to mark an entry as read or unread. Hit <kbd>s</kbd> to toggle starred status. Press <kbd>v</kbd> to open the original article URL in a new browser tab. These shortcuts work whether you&rsquo;re viewing the list or reading an article.</p>

      <h3>Navigation Shortcuts</h3>

      <p>Jump between major sections with two-key combinations. Press <kbd>g</kbd> followed by <kbd>a</kbd> to go to All Items. Press <kbd>g</kbd> then <kbd>s</kbd> for Starred items. Press <kbd>g</kbd> then <kbd>l</kbd> to open your Saved articles. The <kbd>g</kbd> prefix activates for 1.5 seconds, giving you time to press the second key.</p>

      <h3>Smart Focus Detection</h3>

      <p>Shortcuts respect focus state and won&rsquo;t fire when you&rsquo;re typing in a search field or text input. This prevents accidental navigation while you&rsquo;re entering text. But when focus is on the reading interface, every core action is just a keypress away.</p>

      <p>On touch devices, Lion Reader follows WCAG accessibility guidelines with 44px minimum touch targets for comfortable tapping. The interface works great with both keyboard and touch &mdash; use whichever input method fits your current context.</p>
    `,
  },

  // -------------------------------------------------------------------------
  // Organization & Search
  // -------------------------------------------------------------------------
  {
    id: "tags",
    feedId: "organization",
    subscriptionId: "organization",
    type: "web",
    url: null,
    title: "Tags & Folders",
    author: null,
    summary: "Organize subscriptions with color-coded tags and browse entries by category.",
    publishedAt: FEATURE_DATES["tags"],
    fetchedAt: FEATURE_DATES["tags"],
    read: false,
    starred: false,
    feedTitle: "Organization & Search",
    siteName: null,
    contentHtml: `
      <h2>Organize Your Way</h2>

      <p>Lion Reader gives you powerful tools to organize your subscriptions exactly how you want. Create custom tags with names and colors using the built-in hex color picker, then assign them to any combination of subscriptions. Tags are many-to-many, so a single subscription can belong to multiple categories &mdash; perfect for feeds that span multiple interests.</p>

      <p>Once you&rsquo;ve tagged your subscriptions, browse entries filtered by tag directly from the sidebar. Each tag shows real-time unread counts that update as you read and as new entries arrive. Subscriptions without tags appear in the &ldquo;Uncategorized&rdquo; section, so nothing gets lost. Tags work seamlessly across all feed types: web feeds (RSS/Atom/JSON), email newsletters, and saved articles.</p>

      <h3>Custom Titles and Flexible Management</h3>

      <p>Every subscription can be renamed to your preferred label, regardless of the original feed title. This is especially useful for newsletters with overly long names or feeds you want to remember differently. If you unsubscribe from a feed, Lion Reader uses soft deletion to preserve your read and starred state. Resubscribing later restores your full history, so you never lose track of what you&rsquo;ve already read.</p>

      <p>Key features:</p>
      <ul>
        <li><strong>Color-coded tags</strong> &mdash; Custom names with hex color picker</li>
        <li><strong>Many-to-many</strong> &mdash; One subscription can have multiple tags</li>
        <li><strong>Real-time counts</strong> &mdash; Unread counts per tag update live</li>
        <li><strong>Custom subscription titles</strong> &mdash; Rename any subscription to your preference</li>
        <li><strong>Soft-delete</strong> &mdash; Unsubscribing preserves your reading history</li>
      </ul>
    `,
  },
  {
    id: "search",
    feedId: "organization",
    subscriptionId: "organization",
    type: "web",
    url: null,
    title: "Full-Text Search",
    author: null,
    summary: "Search across all your entries by title, content, or both with instant results.",
    publishedAt: FEATURE_DATES["search"],
    fetchedAt: FEATURE_DATES["search"],
    read: false,
    starred: false,
    feedTitle: "Organization & Search",
    siteName: null,
    contentHtml: `
      <h2>Search Everything, Instantly</h2>

      <p>Lion Reader&rsquo;s full-text search is powered by PostgreSQL with English language stemming, giving you fast, relevant results across your entire archive. Search by title, content, or both &mdash; the search scope is fully configurable, so you can narrow down exactly what you&rsquo;re looking for.</p>

      <p>Search results can be combined with any other filter in Lion Reader: subscription, tag, read/unread state, starred entries, or entry type. This makes it easy to search within a specific newsletter, across all saved articles, or just your starred items. Results are ranked by relevance using PostgreSQL&rsquo;s <code>ts_rank</code> algorithm, which weights matches in titles higher than those in body text.</p>

      <h3>Performance and Availability</h3>

      <p>Even with large archives containing thousands of entries, search remains fast thanks to database-level full-text indexing. Results use cursor-based pagination, so you can scroll through unlimited result sets without performance degradation. Search is available everywhere: the web UI, the tRPC API, and the MCP server for AI assistant integrations.</p>

      <p>Search capabilities:</p>
      <ul>
        <li><strong>Full-text search</strong> &mdash; Across title, summary, and content</li>
        <li><strong>Configurable scope</strong> &mdash; Title-only, content-only, or both</li>
        <li><strong>Combine with filters</strong> &mdash; Subscription, tag, read state, starred, entry type</li>
        <li><strong>Relevance ranking</strong> &mdash; Results ranked by <code>ts_rank</code></li>
        <li><strong>Fast indexing</strong> &mdash; Database-level full-text indexes</li>
        <li><strong>Cursor-based pagination</strong> &mdash; Efficient for large result sets</li>
      </ul>
    `,
  },
  {
    id: "scoring",
    feedId: "organization",
    subscriptionId: "organization",
    type: "web",
    url: null,
    title: "Entry Scoring & Recommendations",
    author: null,
    summary:
      "Rate articles and get personalized score predictions powered by on-device machine learning.",
    publishedAt: FEATURE_DATES["scoring"],
    fetchedAt: FEATURE_DATES["scoring"],
    read: false,
    starred: false,
    feedTitle: "Organization & Search",
    siteName: null,
    contentHtml: `
      <h2>Rate Your Reading</h2>

      <p>Lion Reader tracks your preferences through both explicit voting and implicit behavior. Explicit voting uses a 5-point scale from &minus;2 to +2, with LessWrong-style upvote/downvote controls. Rate articles directly to build your preference profile.</p>

      <p>Your implicit behavior also contributes to scoring. Starring an entry signals strong interest (+2), marking an entry as unread to come back to it later shows moderate interest (+1), and marking an entry as read from the list without opening it indicates low interest (&minus;1). Over time, these signals combine to create a detailed picture of what you value.</p>

      <h3>On-Device Machine Learning</h3>

      <p>Once you&rsquo;ve rated at least 20 entries, Lion Reader trains an on-device machine learning model to predict scores for new content. The model uses TF-IDF text vectorization combined with Ridge Regression, with titles weighted 2x during feature extraction. Per-feed features capture your source-level preferences, so the model learns not just what topics you like, but which publications you trust.</p>

      <p>The model is cross-validated using Mean Absolute Error (MAE) and Pearson correlation metrics to ensure prediction quality. Predictions include confidence scores, helping you understand when recommendations are strong versus tentative. The entire system runs in-browser via <a href="https://onnxruntime.ai/" target="_blank" rel="noopener noreferrer">ONNX Runtime</a> WebAssembly, so no data ever leaves your device &mdash; your reading habits remain completely private. New entries are automatically scored after feed fetches, helping you prioritize the content you&rsquo;re most likely to enjoy.</p>

      <p>Scoring features:</p>
      <ul>
        <li><strong>Explicit voting</strong> &mdash; &minus;2 to +2 scale with upvote/downvote controls</li>
        <li><strong>Implicit signals</strong> &mdash; Starring (+2), marking unread (+1), quick-mark-read (&minus;1)</li>
        <li><strong>On-device ML</strong> &mdash; TF-IDF + Ridge Regression model</li>
        <li><strong>Per-feed features</strong> &mdash; Learns source-level preferences</li>
        <li><strong>Confidence scores</strong> &mdash; Know how strong each prediction is</li>
        <li><strong>Fully private</strong> &mdash; Runs in-browser via ONNX Runtime WebAssembly</li>
      </ul>
    `,
  },
  {
    id: "opml",
    feedId: "organization",
    subscriptionId: "organization",
    type: "web",
    url: null,
    title: "OPML Import & Export",
    author: null,
    summary:
      "Migrate to or from Lion Reader with standard OPML files, or back up your subscriptions.",
    publishedAt: FEATURE_DATES["opml"],
    fetchedAt: FEATURE_DATES["opml"],
    read: false,
    starred: false,
    feedTitle: "Organization & Search",
    siteName: null,
    contentHtml: `
      <h2>Portable Subscriptions</h2>

      <p>OPML (Outline Processor Markup Language) is the standard format for exchanging feed subscriptions between readers. Lion Reader supports full OPML import and export, making it easy to migrate to or from any other feed reader, or simply back up your subscriptions. The OPML format is documented in the <a href="http://opml.org/spec2.opml" target="_blank" rel="noopener noreferrer">OPML 2.0 specification</a>.</p>

      <h3>Import from Anywhere</h3>

      <p>Upload an OPML file from any feed reader &mdash; Feedly, Inoreader, NetNewsWire, or dozens of others. Lion Reader processes imports in the background with real-time progress updates delivered via Server-Sent Events. Each feed is validated and fetched during import to ensure it&rsquo;s still active. The importer preserves folder and tag structure from your original reader, translating folder hierarchies into Lion Reader&rsquo;s tag system.</p>

      <p>The import process is smart: it automatically skips feeds you&rsquo;re already subscribed to and provides detailed per-feed status reports. You&rsquo;ll see which feeds were successfully imported, which were skipped, and which failed with specific error messages. Lion Reader also supports service-specific migrations, including a dedicated Feedbin importer.</p>

      <h3>Export Your Library</h3>

      <p>Export all your subscriptions as OPML 2.0 with a single click. The export includes custom titles and your complete tag/folder hierarchy, making it compatible with any OPML-supporting reader. This is perfect for creating backups, migrating between readers, or sharing curated subscription lists with friends.</p>

      <p>OPML features:</p>
      <ul>
        <li><strong>Import</strong> &mdash; From any OPML-compatible reader</li>
        <li><strong>Live progress</strong> &mdash; Background processing with real-time SSE updates</li>
        <li><strong>Folder preservation</strong> &mdash; Tag structure imported from source reader</li>
        <li><strong>Per-feed status</strong> &mdash; Imported, skipped, or failed with error details</li>
        <li><strong>One-click export</strong> &mdash; OPML 2.0 with custom titles and tags</li>
        <li><strong>Service migrations</strong> &mdash; Dedicated importers for Feedbin and more</li>
      </ul>
    `,
  },

  // -------------------------------------------------------------------------
  // Integrations & Sync
  // -------------------------------------------------------------------------
  {
    id: "mcp-server",
    feedId: "integrations",
    subscriptionId: "integrations",
    type: "web",
    url: null,
    title: "MCP Server",
    author: null,
    summary: "Connect Lion Reader to AI assistants like Claude via the Model Context Protocol.",
    publishedAt: FEATURE_DATES["mcp-server"],
    fetchedAt: FEATURE_DATES["mcp-server"],
    read: false,
    starred: false,
    feedTitle: "Integrations & Sync",
    siteName: null,
    contentHtml: `
      <h2>What is MCP?</h2>

      <p>The <a href="https://modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer">Model Context Protocol (MCP)</a> is an open standard for connecting AI assistants to external tools and data sources. Think of it as a universal adapter that lets AI models like Claude interact with your applications in a secure, structured way. Instead of manually copying data between your feed reader and your AI assistant, MCP enables direct, programmatic access.</p>

      <p>Lion Reader&rsquo;s MCP server is built with the official <a href="https://github.com/modelcontextprotocol/typescript-sdk" target="_blank" rel="noopener noreferrer">MCP TypeScript SDK</a> and uses stdio transport for secure local communication. This means the connection stays entirely on your machine &mdash; no data is sent to external servers beyond what your AI assistant already does.</p>

      <h3>Available Tools</h3>

      <p>The Lion Reader MCP server exposes a comprehensive set of tools that mirror the web UI&rsquo;s capabilities:</p>

      <ul>
        <li><strong>list_entries</strong> &mdash; List feed entries with filters and pagination</li>
        <li><strong>search_entries</strong> &mdash; Full-text search across all entries</li>
        <li><strong>get_entry</strong> &mdash; Get a single entry with full content</li>
        <li><strong>mark_entries_read</strong> &mdash; Mark entries as read or unread in bulk</li>
        <li><strong>star_entries</strong> &mdash; Star or unstar entries</li>
        <li><strong>count_entries</strong> &mdash; Get entry counts with filters</li>
        <li><strong>save_article</strong> &mdash; Save a URL for later reading</li>
        <li><strong>delete_saved_article</strong> &mdash; Remove a saved article</li>
        <li><strong>upload_article</strong> &mdash; Upload Markdown content as an article</li>
        <li><strong>list_subscriptions</strong> &mdash; List all active subscriptions</li>
        <li><strong>search_subscriptions</strong> &mdash; Search subscriptions by title</li>
        <li><strong>get_subscription</strong> &mdash; Get subscription details</li>
      </ul>

      <h3>Consistent Behavior</h3>

      <p>The MCP server uses the same services layer as the web UI, ensuring behavior is identical across interfaces. Whether you&rsquo;re reading entries through your browser or asking Claude to summarize them, you&rsquo;re accessing the same underlying data with the same permissions and filters.</p>

      <h3>Security and Usage</h3>

      <p>Access is secured via API tokens with scoped permissions. You can generate tokens from your account settings and configure which operations each token can perform. The server is compatible with Claude Desktop and other MCP-supporting assistants. To run the server locally, use <code>pnpm mcp:serve</code> and configure your AI assistant to connect to it.</p>
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
    summary: "Receive instant updates from feeds that support the W3C WebSub push protocol.",
    publishedAt: FEATURE_DATES["websub"],
    fetchedAt: FEATURE_DATES["websub"],
    read: false,
    starred: false,
    feedTitle: "Integrations & Sync",
    siteName: null,
    contentHtml: `
      <h2>What is WebSub?</h2>

      <p>WebSub is a <a href="https://www.w3.org/TR/websub/" target="_blank" rel="noopener noreferrer">W3C standard</a> for real-time content delivery, formerly known as PubSubHubbub. Instead of Lion Reader repeatedly checking feeds for new content (polling), WebSub allows publishers to push updates directly to subscribers the moment new content is published. This is the same technology that powers real-time updates across much of the modern web.</p>

      <h3>How It Works</h3>

      <p>When you subscribe to a feed, Lion Reader automatically checks if the feed advertises a WebSub hub URL in its <code>&lt;link&gt;</code> headers. If it does, Lion Reader subscribes to that hub with a callback URL. The hub then verifies the subscription via a challenge-response handshake to ensure the request is legitimate.</p>

      <p>Once subscribed, the publisher&rsquo;s hub pushes new content directly to Lion Reader the moment it&rsquo;s published. Lion Reader processes this pushed content just like a regular fetch &mdash; parsing entries, deduplicating, and notifying you via real-time updates. The entire process happens automatically in the background with no manual configuration required.</p>

      <h3>Benefits Over Polling</h3>

      <ul>
        <li><strong>Near-instant delivery</strong> &mdash; New content arrives in seconds instead of minutes</li>
        <li><strong>Reduced server load</strong> &mdash; Both Lion Reader and the feed publisher benefit from fewer requests</li>
        <li><strong>Lower bandwidth usage</strong> &mdash; No need to repeatedly fetch unchanged feeds</li>
        <li><strong>Better user experience</strong> &mdash; Breaking news and time-sensitive content appears immediately</li>
      </ul>

      <h3>Automatic Detection</h3>

      <p>Lion Reader discovers and subscribes to WebSub hubs automatically for any feed that supports them. For feeds without WebSub support, Lion Reader seamlessly falls back to regular polling. Subscription renewal and error handling are built in, so the system is resilient to hub outages and network issues.</p>
    `,
  },
  {
    id: "pwa",
    feedId: "integrations",
    subscriptionId: "integrations",
    type: "web",
    url: null,
    title: "Progressive Web App",
    author: null,
    summary: "Install Lion Reader on your phone or desktop for a native app-like experience.",
    publishedAt: FEATURE_DATES["pwa"],
    fetchedAt: FEATURE_DATES["pwa"],
    read: false,
    starred: false,
    feedTitle: "Integrations & Sync",
    siteName: null,
    contentHtml: `
      <h2>Install Anywhere</h2>

      <p>Lion Reader is a full Progressive Web App (PWA). This means you can install it on any device &mdash; desktop (Chrome, Edge, Firefox) or mobile (iOS Safari, Android Chrome) &mdash; and get a native app-like experience without downloading anything from an app store. Once installed, Lion Reader runs in its own window with no browser chrome, just like any other app on your device.</p>

      <h3>Share Target Integration</h3>

      <p>One of the most powerful PWA features is share target integration. When you install Lion Reader on your phone, it registers as a share target with your operating system. This means you can save articles directly to Lion Reader using your phone&rsquo;s native share menu from any app &mdash; your browser, Twitter, Reddit, or anywhere else.</p>

      <p>But it goes beyond just URLs. Lion Reader&rsquo;s share target also accepts files, so you can share PDFs, Markdown documents, or even Word files directly into your saved articles. The app automatically detects the content type and processes each file appropriately. This makes Lion Reader a universal inbox for anything you want to read later, not just web content.</p>

      <h3>Mobile Optimizations</h3>

      <p>On mobile devices, the app locks to portrait orientation for optimal reading. This prevents the screen from rotating while you&rsquo;re reading long articles, reducing distractions and maintaining a consistent layout. Combined with push notifications for new entries, the mobile experience rivals dedicated feed reader apps.</p>

      <h3>Single Codebase</h3>

      <p>Unlike traditional native apps, Lion Reader uses a single codebase for web, desktop, and mobile. This means new features and bug fixes ship everywhere simultaneously. No app store reviews, no separate update cycles &mdash; just install directly from the website and get updates automatically. The PWA approach gives you the best of both worlds: the convenience of native apps with the flexibility and speed of the web.</p>
    `,
  },
  {
    id: "real-time",
    feedId: "integrations",
    subscriptionId: "integrations",
    type: "web",
    url: null,
    title: "Real-Time Updates",
    author: null,
    summary:
      "See new entries appear instantly with Server-Sent Events and smart cache invalidation.",
    publishedAt: FEATURE_DATES["real-time"],
    fetchedAt: FEATURE_DATES["real-time"],
    read: false,
    starred: false,
    feedTitle: "Integrations & Sync",
    siteName: null,
    contentHtml: `
      <h2>Server-Sent Events Architecture</h2>

      <p>Lion Reader uses Server-Sent Events (SSE) powered by Redis pub/sub to deliver real-time updates without polling. When a feed worker fetches new content, it publishes events to Redis channels. Your browser maintains an open SSE connection that listens to these channels, receiving updates the moment they happen. This architecture is both efficient and scalable &mdash; your connection only subscribes to events for feeds you actually care about.</p>

      <h3>Channel Types</h3>

      <ul>
        <li><strong>Per-feed channels</strong> &mdash; Each feed has its own channel (<code>feed:{feedId}:events</code>). When you subscribe to a feed, your SSE connection automatically subscribes to that feed&rsquo;s channel. This means you only receive events for feeds you follow, reducing noise and bandwidth.</li>
        <li><strong>Per-user channels</strong> &mdash; Account-level events like subscription changes and OPML import progress use a dedicated user channel (<code>user:{userId}:events</code>). This ensures actions taken in other browser sessions appear instantly across all your devices.</li>
      </ul>

      <h3>Event Types</h3>

      <p>Lion Reader sends several types of real-time events:</p>

      <ul>
        <li><strong>new_entry</strong> &mdash; A new article was published to a feed you subscribe to</li>
        <li><strong>entry_updated</strong> &mdash; An article&rsquo;s content was updated by the publisher</li>
        <li><strong>subscription_created</strong> &mdash; You added a new subscription from another device or session</li>
        <li><strong>import_progress</strong> &mdash; Real-time status updates during OPML import</li>
      </ul>

      <h3>Smart Cache Invalidation</h3>

      <p>When an SSE event arrives, Lion Reader triggers targeted React Query cache invalidations. This means the UI refreshes automatically without manual polling or full page reloads. Optimistic updates for actions like starring and marking entries read mean the UI updates instantly before the server confirms, then reconciles if something went wrong. The result is a responsive interface that feels immediate even on slower connections.</p>

      <h3>Reliability and Fallbacks</h3>

      <p>The SSE connection includes a heartbeat keepalive every 30 seconds to detect and recover from network issues. If Redis becomes unavailable, Lion Reader gracefully degrades to a timestamp-based sync endpoint that provides eventual consistency without real-time updates. When you subscribe to a new feed, your SSE connection dynamically starts listening to that feed&rsquo;s channel without reconnecting, ensuring you never miss new content.</p>
    `,
  },

  // -------------------------------------------------------------------------
  // About / Lion Reader
  // -------------------------------------------------------------------------
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
      <h2>Welcome to Lion Reader</h2>

      <p>Lion Reader is a modern, self-hostable feed reader built for people who care about their reading experience. Whether you&rsquo;re following hundreds of feeds or just a handful, Lion Reader brings all your content together in one fast, elegant interface.</p>

      <p>This interactive demo shows the real Lion Reader UI &mdash; browse the sidebar to explore different features and see what makes this reader special. Everything you see here works exactly like the production app.</p>

      <h3>Key Features</h3>

      <ul>
        <li><strong>All your content in one place</strong> &mdash; Subscribe to RSS, Atom, and JSON feeds, receive email newsletters directly into your reader, and save articles from around the web for later reading.</li>
        <li><strong>AI-powered reading</strong> &mdash; Get instant article summaries powered by Claude, listen to entries with high-quality text-to-speech narration, and let on-device ML predict which articles you&rsquo;ll love.</li>
        <li><strong>MCP integration</strong> &mdash; Connect AI assistants like Claude Desktop directly to your feeds via the Model Context Protocol. Let your AI help you search, organize, and manage your reading list.</li>
        <li><strong>Keyboard-first design</strong> &mdash; Navigate your entire reading experience without touching your mouse. Every action has a keyboard shortcut.</li>
        <li><strong>Real-time updates</strong> &mdash; New entries appear instantly via Server-Sent Events. No refreshing, no polling, just seamless updates as content arrives.</li>
        <li><strong>Progressive Web App</strong> &mdash; Install Lion Reader on desktop or mobile for a native app experience. Share articles directly from your phone.</li>
        <li><strong>Privacy-focused</strong> &mdash; Self-hostable and open source. No tracking, no ads, no data mining. Your reading habits are yours alone.</li>
        <li><strong>On-device ML</strong> &mdash; Score predictions run locally in your browser via ONNX Runtime. Your reading patterns never leave your device.</li>
      </ul>

      <h3>Explore the Demo</h3>

      <p>The sidebar is organized into sections that showcase different capabilities:</p>

      <ul>
        <li><strong>Feed Types</strong> &mdash; See how Lion Reader handles RSS feeds, email newsletters, and saved articles</li>
        <li><strong>Reading Experience</strong> &mdash; Explore full content fetching, AI summaries, text-to-speech, and keyboard navigation</li>
        <li><strong>Organization &amp; Search</strong> &mdash; Learn about tags, full-text search, ML-powered scoring, and OPML import/export</li>
        <li><strong>Integrations &amp; Sync</strong> &mdash; Discover MCP integration, WebSub push, the PWA, and real-time updates</li>
      </ul>

      <p>Ready to take control of your reading? Sign up to start using the full app, or <a href="https://github.com/brendanlong/lion-reader" target="_blank" rel="noopener noreferrer">check out the source code on GitHub</a> to self-host your own instance.</p>
    `,
  },
  {
    id: "open-source",
    feedId: "lion-reader",
    subscriptionId: "lion-reader",
    type: "web",
    url: "https://github.com/brendanlong/lion-reader",
    title: "Open Source & Self-Hostable",
    author: null,
    summary:
      "Lion Reader is fully open source. Self-host it, explore the code, or contribute on GitHub.",
    publishedAt: FEATURE_DATES["open-source"],
    fetchedAt: FEATURE_DATES["open-source"],
    read: false,
    starred: false,
    feedTitle: "Lion Reader",
    siteName: null,
    contentHtml: `
      <h2>Open Source &amp; Self-Hostable</h2>

      <p>Lion Reader is fully open source and designed to be self-hosted. Every line of code is available on <a href="https://github.com/brendanlong/lion-reader" target="_blank" rel="noopener noreferrer">GitHub</a> for you to inspect, modify, and deploy on your own infrastructure. When you self-host Lion Reader, you own your data completely &mdash; no third-party services, no vendor lock-in, just you and your feeds.</p>

      <h3>Modern Tech Stack</h3>

      <p>Lion Reader is built with cutting-edge technologies chosen for performance, developer experience, and long-term maintainability:</p>

      <ul>
        <li><strong>Frontend</strong> &mdash; <a href="https://nextjs.org/" target="_blank" rel="noopener noreferrer">Next.js</a> 16 with React 19, <a href="https://tailwindcss.com/" target="_blank" rel="noopener noreferrer">Tailwind CSS</a> 4 for styling</li>
        <li><strong>API</strong> &mdash; <a href="https://trpc.io/" target="_blank" rel="noopener noreferrer">tRPC</a> for end-to-end type-safe APIs with <a href="https://zod.dev/" target="_blank" rel="noopener noreferrer">Zod</a> 4 validation</li>
        <li><strong>Database</strong> &mdash; PostgreSQL with <a href="https://orm.drizzle.team/" target="_blank" rel="noopener noreferrer">Drizzle ORM</a> for type-safe queries, UUIDv7 primary keys</li>
        <li><strong>Caching &amp; Real-time</strong> &mdash; Redis for session caching, rate limiting, and SSE pub/sub</li>
        <li><strong>Auth</strong> &mdash; Custom session management with <a href="https://arcticjs.dev/" target="_blank" rel="noopener noreferrer">Arctic</a> for OAuth (Google, Apple, Discord), Argon2 password hashing</li>
        <li><strong>AI</strong> &mdash; <a href="https://www.anthropic.com/" target="_blank" rel="noopener noreferrer">Anthropic</a> SDK for summaries, <a href="https://groq.com/" target="_blank" rel="noopener noreferrer">Groq</a> for narration preprocessing, <a href="https://onnxruntime.ai/" target="_blank" rel="noopener noreferrer">ONNX Runtime</a> for on-device ML</li>
        <li><strong>Feed parsing</strong> &mdash; fast-xml-parser for SAX-style streaming, htmlparser2 for HTML, Mozilla Readability for content extraction</li>
        <li><strong>Deployment</strong> &mdash; <a href="https://fly.io/" target="_blank" rel="noopener noreferrer">Fly.io</a> with auto-scaling, Docker Compose for local development</li>
        <li><strong>Testing</strong> &mdash; <a href="https://vitest.dev/" target="_blank" rel="noopener noreferrer">Vitest</a> with real database integration tests (no mocks)</li>
        <li><strong>Observability</strong> &mdash; <a href="https://sentry.io/" target="_blank" rel="noopener noreferrer">Sentry</a> for error tracking, structured JSON logging, Prometheus metrics</li>
      </ul>

      <h3>Architecture Highlights</h3>

      <ul>
        <li><strong>Stateless app servers</strong> &mdash; All state lives in Postgres and Redis, enabling horizontal scaling</li>
        <li><strong>Services layer</strong> &mdash; Shared business logic between tRPC routers, MCP server, and background jobs</li>
        <li><strong>Cursor-based pagination</strong> &mdash; Efficient pagination everywhere using UUIDv7 cursors</li>
        <li><strong>Background job queue</strong> &mdash; Built on Postgres for reliable feed fetching with exponential backoff</li>
        <li><strong>Efficient data sharing</strong> &mdash; Feed and entry data deduplicated across users with strict privacy boundaries</li>
      </ul>

      <h3>Contributing</h3>

      <p>Contributions are welcome! Check out the <a href="https://github.com/brendanlong/lion-reader/issues" target="_blank" rel="noopener noreferrer">open issues</a> to find ways to help, or explore the architecture documentation in the repository to understand how everything fits together. The codebase includes comprehensive design docs, architecture diagrams, and testing guidelines to help you get started.</p>
    `,
  },
  {
    id: "auth-security",
    feedId: "lion-reader",
    subscriptionId: "lion-reader",
    type: "web",
    url: null,
    title: "Authentication & Security",
    author: null,
    summary: "Sign in with email, Google, Apple, or Discord. API tokens for extensions and MCP.",
    publishedAt: FEATURE_DATES["auth-security"],
    fetchedAt: FEATURE_DATES["auth-security"],
    read: false,
    starred: false,
    feedTitle: "Lion Reader",
    siteName: null,
    contentHtml: `
      <h2>Authentication &amp; Security</h2>

      <p>Lion Reader takes security and privacy seriously. Whether you&rsquo;re signing in with email or OAuth, managing API tokens, or connecting AI assistants, your data is protected with industry-standard security practices.</p>

      <h3>Multiple Sign-In Methods</h3>

      <p>Choose the authentication method that works best for you:</p>

      <ul>
        <li><strong>Email and password</strong> &mdash; Traditional authentication with Argon2 password hashing, one of the most secure hashing algorithms available</li>
        <li><strong>Google OAuth</strong> &mdash; Sign in with your Google account, with optional Google Docs access for importing documents</li>
        <li><strong>Apple Sign-In</strong> &mdash; Native Apple authentication with support for private relay email addresses</li>
        <li><strong>Discord OAuth</strong> &mdash; Connect with your Discord account for quick sign-in</li>
      </ul>

      <p>All OAuth providers are optional and can be enabled or disabled per deployment. Your Lion Reader instance, your choice.</p>

      <h3>Session Management</h3>

      <ul>
        <li><strong>Secure storage</strong> &mdash; Session tokens are stored as SHA-256 hashes, never in plain text</li>
        <li><strong>Redis caching</strong> &mdash; Sessions are cached for fast validation with a 5-minute TTL</li>
        <li><strong>Active session tracking</strong> &mdash; View all your sessions with device type, IP address, and last active timestamp</li>
        <li><strong>Revocation</strong> &mdash; Revoke any session instantly from the settings page</li>
      </ul>

      <h3>API Tokens</h3>

      <p>Connect external tools and scripts to your Lion Reader account with API tokens:</p>

      <ul>
        <li><strong>Scoped permissions</strong> &mdash; Tokens can be limited to specific capabilities like saved:write or mcp</li>
        <li><strong>Expiration dates</strong> &mdash; Set automatic expiration for temporary access</li>
        <li><strong>Usage tracking</strong> &mdash; See when each token was last used</li>
        <li><strong>Perfect for extensions</strong> &mdash; Use API tokens to connect browser extensions, the MCP server, or the Discord bot</li>
      </ul>

      <h3>Security Features</h3>

      <ul>
        <li><strong>Rate limiting</strong> &mdash; Per-user rate limiting via Redis token bucket prevents abuse</li>
        <li><strong>Outbound throttling</strong> &mdash; Feed fetching respects per-domain rate limits (1 req/sec) to be a good internet citizen</li>
        <li><strong>Webhook verification</strong> &mdash; Email webhooks use HMAC signature verification</li>
        <li><strong>Content sanitization</strong> &mdash; All feed content is sanitized to prevent XSS attacks</li>
        <li><strong>Invite-only mode</strong> &mdash; Deploy with invite-only registration to control access</li>
      </ul>

      <h3>Privacy Protections</h3>

      <ul>
        <li><strong>Subscription-based visibility</strong> &mdash; You only see entries fetched after you subscribed, preventing access to historical private content</li>
        <li><strong>Starred entry preservation</strong> &mdash; Entries you&rsquo;ve starred remain visible even after unsubscribing</li>
        <li><strong>Soft deletes</strong> &mdash; Unsubscribing preserves your read state and preferences for seamless resubscription</li>
        <li><strong>No tracking</strong> &mdash; Lion Reader doesn&rsquo;t track your reading habits, show ads, or share data with third parties</li>
      </ul>
    `,
  },
];

// ============================================================================
// Lookup helpers
// ============================================================================

/** Sort entries newest-first by publishedAt date */
function sortNewestFirst(entries: DemoEntry[]): DemoEntry[] {
  return [...entries].sort(
    (a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0)
  );
}

/** All entries sorted newest-first for display */
export const DEMO_ENTRIES_SORTED = sortNewestFirst(DEMO_ENTRIES);

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
  return sortNewestFirst(entriesBySubscription.get(subscriptionId) ?? []);
}

/** Get entries for a tag (entries from all subscriptions in that tag) */
export function getDemoEntriesForTag(tagId: string): DemoEntry[] {
  const tag = DEMO_TAGS.find((t) => t.id === tagId);
  if (!tag) return [];
  const subIds = new Set(tag.subscriptionIds);
  return sortNewestFirst(
    DEMO_ENTRIES.filter((e) => e.subscriptionId && subIds.has(e.subscriptionId))
  );
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
  return sortNewestFirst(DEMO_ENTRIES.filter((e) => e.starred));
}

/** Get EntryArticle props for a demo entry */
export function getDemoEntryArticleProps(
  entry: DemoEntry
): Pick<
  EntryArticleProps,
  "title" | "url" | "source" | "author" | "date" | "contentHtml" | "fallbackContent"
> {
  return {
    title: entry.title ?? "Untitled",
    url: entry.url,
    source: entry.feedTitle ?? "Lion Reader",
    author: entry.author,
    date: entry.publishedAt ?? entry.fetchedAt,
    contentHtml: entry.contentHtml,
    fallbackContent: entry.summary,
  };
}

/** Total entry count */
export const DEMO_TOTAL_COUNT = DEMO_ENTRIES.length;
