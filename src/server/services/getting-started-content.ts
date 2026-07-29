/**
 * The Getting Started onboarding article (issue #1397).
 *
 * Plain Markdown so it goes in through the ordinary upload path
 * (`uploadArticle`) — same dialect, same sanitization, same excerpt handling as
 * anything a user saves. See `getting-started.ts` for the insert.
 *
 * Two things to keep in mind when editing the body:
 *
 * - **Don't hard-wrap inside a paragraph.** Our Markdown dialect renders a
 *   single newline as a `<br>`, so a wrapped source line becomes a ragged line
 *   break in the article. One line per paragraph / list item.
 * - **Links into the app must be relative**, so they resolve on any instance
 *   including self-hosted ones (the sanitizer leaves relative hrefs alone and
 *   only gives external ones `target="_blank"`). Only link to routes that
 *   exist — `tests/unit/getting-started-content.test.ts` checks the in-app ones
 *   against the app's actual route list.
 */

/** Title of the Getting Started article. */
export const GETTING_STARTED_TITLE = "Getting Started with Lion Reader";

/** Excerpt shown in the entry list, instead of the first lines of the body. */
export const GETTING_STARTED_EXCERPT =
  "A short tour of Lion Reader: getting content in, reading it your way, " +
  "optional AI summaries and narration, connecting AI agents over MCP, and apps for your phone.";

/**
 * The article body, in the GFM dialect `@/server/markdown` renders.
 *
 * No H1: `processMarkdown` would strip a leading H1 into the title, and the
 * title is passed explicitly anyway.
 */
export const GETTING_STARTED_MARKDOWN = `
Welcome! This article is starred, so you can always find it again under [Starred](/starred). When you're done with it, unstar it or delete it — it won't come back.

## 1. Get some content in

- **Subscribe to a feed.** Go to [Subscribe](/subscribe) and paste a site's address — you don't need to hunt for the feed URL, we'll find it for you.
- **Coming from another reader?** Export an OPML file from it and import the whole thing at once under [Settings → Subscriptions](/settings/subscriptions).
- **Newsletters.** Create a private ingest address under [Settings → Email](/settings/email) and subscribe to newsletters with it. They arrive as entries instead of cluttering your inbox, and you can block a sender later from the same page.
- **Save pages to read later.** Install the browser extension or bookmarklet from [Settings → Integrations](/settings/integrations), or use the **Upload** button in the header for a Markdown, HTML, or Word file. Saved articles land in [Saved](/saved). arXiv, GitHub, Google Docs, LessWrong, YouTube, and Bluesky links get special handling, so you get the real content rather than a landing page.

## 2. Read it your way

Everything lands in [All](/all), and each feed and [tag](/settings/subscriptions) has its own view in the sidebar.

- **Keyboard first.** \`j\` / \`k\` move between entries, \`o\` opens one, \`s\` stars, \`m\` toggles read, \`u\` shows or hides read entries, \`/\` searches, and \`?\` lists every shortcut. You can turn shortcuts off in [Settings](/settings).
- **On a phone or tablet**, swipe left and right inside an article to move to the next or previous one.
- **Feed only giving you a teaser?** Turn on full-content fetching for that subscription and we'll pull the whole article in for you.

## 3. Make it yours

[Settings → Appearance](/settings/appearance) has light, dark, and e-paper themes, four reading fonts, text size and alignment, and a compact list density if you'd rather see more entries at once.

## 4. Optional: AI summaries and narration

Both are opt-in, and neither runs behind your back.

- Add an **Anthropic** or **Cerebras** API key under [Settings → AI & Narration](/settings/ai) to get article summaries on demand. Nothing is ever summarized until you ask for it.
- **Narration** reads articles aloud with synchronized highlighting. It works without any API key; a **Cerebras** or **Groq** key just lets it tidy the text up first so it reads more naturally. If you don't want it at all, turn narration off on the same page.

## 5. Optional: connect an AI agent over MCP

Lion Reader is an [MCP](https://modelcontextprotocol.io/) server, so an agent like Claude Code can search your feeds, mark things read, save a URL, or upload an article it wrote for you.

[Settings → Integrations](/settings/integrations) has your personal MCP URL and copy-paste setup for Claude Code and Claude Desktop. The claude.ai **web** connector doesn't work yet — that's a bug on their side, tracked in [issue #986](https://github.com/brendanlong/lion-reader/issues/986).

## 6. Optional: apps for your phone and desktop

- **Install Lion Reader itself.** It's a PWA: use your browser's "Install" or "Add to Home Screen" option. You get an app icon, and Lion Reader shows up in your phone's share menu for saving links.
- **Prefer a native client?** Enable the Google Reader API under [Settings → Integrations](/settings/integrations) to sync with Reeder, NetNewsWire, Read You, NewsFlash, and friends. The Wallabag API on the same page connects the Wallabag mobile apps to your saved articles.

---

Curious about the rest? The [feature tour](/demo/all?entry=welcome) goes deeper on all of this, and Lion Reader is [open source](https://github.com/brendanlong/lion-reader) if you'd like to file an issue or host your own.
`.trim();
