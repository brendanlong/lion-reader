/**
 * The Getting Started collection's articles (issue #1397), in reading order.
 *
 * Plain Markdown so they go in through the ordinary upload path — same
 * dialect, same sanitization, same excerpt handling as anything a user saves.
 * See `getting-started.ts` for the insert.
 *
 * Several short articles rather than one long one, so a new user who skims
 * the first still sees the rest waiting in the collection.
 *
 * When editing the bodies:
 *
 * - **Don't start with a heading**: `processMarkdown` takes a leading one as
 *   the title and strips it.
 * - **Don't hard-wrap inside a paragraph.** Our Markdown dialect renders a
 *   single newline as a `<br>`, so a wrapped source line becomes a ragged line
 *   break in the article. One line per paragraph / list item.
 * - **Links into the app must be relative**, so they resolve on any instance
 *   including self-hosted ones (the sanitizer leaves relative hrefs alone and
 *   only gives external ones `target="_blank"`). Link a settings section as
 *   `/settings/<page>#<settings-search id>`. Only link to routes and sections
 *   that exist — `tests/unit/getting-started-content.test.ts` checks them.
 * - Write about what the reader can do, and name apps and providers as
 *   examples, never complete lists (as in `src/lib/demo/articles/CLAUDE.md`).
 */

import {
  CHROME_EXTENSION_URL,
  FIREFOX_EXTENSION_URL,
  WALLABAG_ANDROID_APP_URL,
  WALLABAG_IOS_APP_URL,
} from "@/lib/app-listings";
import { CONTACT_EMAIL, DISCORD_SERVER_URL, FEEDBACK_FORM_URL } from "@/lib/contact";
import { LION_READER_ISSUES_URL, LION_READER_REPO_URL } from "@/lib/github-issue";

export const GETTING_STARTED_COLLECTION_NAME = "Getting Started";

export interface GettingStartedArticle {
  /** Stable per article: part of its upload idempotency key. */
  key: string;
  title: string;
  /** Shown in the entry list, instead of the first lines of the body. */
  excerpt: string;
  /** GFM, in the dialect `@/server/markdown` renders. */
  markdown: string;
}

const NATIVE_APP_BETA = `email [${CONTACT_EMAIL}](mailto:${CONTACT_EMAIL}) or ask in our [Discord server](${DISCORD_SERVER_URL})`;

export const GETTING_STARTED_ARTICLES: readonly GettingStartedArticle[] = [
  {
    key: "subscribe",
    title: "Subscribe to Feeds and Newsletters",
    excerpt:
      "Follow websites and blogs, bring your subscriptions over from another reader, " +
      "and get email newsletters in Lion Reader instead of your inbox.",
    markdown: `
Welcome to Lion Reader! The articles in this Getting Started collection walk through what you can do, one topic at a time. First things first: something to read.

## Follow a website or blog

Go to [Subscribe](/subscribe) and paste the address of any site you'd like to follow. You don't need to hunt for its RSS or Atom feed — Lion Reader finds it for you, shows you a preview, and new posts land in [All](/all) from then on.

Organize your subscriptions with [tags](/settings/subscriptions#tags); each tag gets its own list in the sidebar.

## Coming from another reader?

Export an OPML file from your old reader (almost every reader can) and import it under [Settings → Subscriptions → Import / Export](/settings/subscriptions#import-export). Every feed comes over at once, along with your folders as tags.

## Get newsletters here instead of your inbox

Create a private address under [Settings → Email → Newsletter Addresses](/settings/email#ingest-addresses) and use it anywhere a newsletter asks for your email. Each sender becomes its own subscription automatically. For newsletters you already get, change your email address in your account on the newsletter's website; forwarding from your old inbox doesn't work, since every issue would arrive from you.

When you unsubscribe from a newsletter, Lion Reader takes you off its mailing list for you where the newsletter supports it, and can block the sender so nothing more arrives.
`.trim(),
  },
  {
    key: "save",
    title: "Save Articles to Read Later",
    excerpt:
      "Save any web page, upload documents and books, and save from your browser, " +
      "your phone, or Discord.",
    markdown: `
Found something you want to read later? Save it, and it lands in [Saved](/saved), cleaned up and ready to read, star, listen to, or summarize. Links from sites like arXiv, GitHub, Google Docs, LessWrong, and YouTube get special handling, so you get the real content rather than a landing page.

## From your browser

Install the extension for [Firefox](${FIREFOX_EXTENSION_URL}) or [Chrome](${CHROME_EXTENSION_URL}) (which also works in Chromium browsers like Edge and Brave). Click its toolbar button, press Ctrl+Shift+S (Cmd+Shift+S on a Mac), or right-click a page or link and choose "Save to Lion Reader".

Using another browser? Drag the bookmarklet from [Settings → Integrations → Save to Lion Reader](/settings/integrations#save-to-lion-reader) to your bookmarks bar.

## Upload files

Use the **Upload** button at the top of the app to add a PDF, Word (.docx) document, Markdown, HTML, or plain text file, and it becomes a saved article like any other. Upload an ebook (EPUB) and it becomes a collection with one article per chapter, in reading order.

## From your phone

Our Android app and the Wallabag apps let you save from your phone's share menu, and so does Lion Reader installed to your home screen on Android. The last article in this collection, **Lion Reader on Your Phone and Other Apps**, explains how to set each one up.

## From Discord

React to any message with a link in a server that has our Discord bot, or send the link to the bot directly. Set it up under [Settings → Integrations → Discord Bot](/settings/integrations#discord-bot).

## Organize with collections

A collection is a list of articles you put together yourself, like this one. Add any article to a collection with the collections button at the top of the article. To put a collection in a particular order, ask a connected AI assistant (see **Connect an AI Assistant**).
`.trim(),
  },
  {
    key: "reading",
    title: "Reading Tips",
    excerpt:
      "Keyboard shortcuts, swiping between articles, full articles from feeds that " +
      "only send a teaser, and choosing when articles count as read.",
    markdown: `
Everything you follow lands in [All](/all), and each subscription, tag, and collection has its own list in the sidebar.

## Use the keyboard

If you've used Google Reader or Gmail, the keys will feel familiar:

- \`j\` / \`k\` — next and previous article
- \`o\` or Enter to open, Escape to close
- \`s\` — star
- \`m\` — mark read or unread
- \`u\` — show or hide articles you've read
- \`/\` — search
- \`?\` — every shortcut

If you'd rather not have shortcuts, turn them off under [Settings → Reading → Keyboard Shortcuts](/settings/reading#keyboard-shortcuts).

## On a phone or tablet

Swipe left and right inside an article to move to the next or previous one.

## Get the whole article

If a feed only sends a teaser, press **Full Content** at the top of one of its articles, and Lion Reader fetches every article from that feed from the site for you.

## Choose when articles count as read

By default, an article is marked read when you open it. Under [Settings → Reading → Mark as Read](/settings/reading#mark-read) you can have that wait until you've finished it, or never happen automatically, separately on each browser you use. Lost track of something you read? [Recently Read](/recently-read) lists it.
`.trim(),
  },
  {
    key: "appearance",
    title: "Make It Look the Way You Like",
    excerpt:
      "Light, dark, and e-paper themes, reading fonts and text size, and a compact " +
      "or card-style article list.",
    markdown: `
Lion Reader is meant to be comfortable to read in for a long time, so make it look the way you like:

- **Theme** — light, dark, an e-paper theme for e-ink screens, or follow your system. Pick one under [Settings → Appearance → Theme](/settings/appearance#theme).
- **Article text** — the font, text size, and alignment of the articles themselves, under [Article Text](/settings/appearance#article-text).
- **Article list** — compact rows to see more at once, or cards with previews, under [Entry List](/settings/appearance#entry-list).
`.trim(),
  },
  {
    key: "ai",
    title: "Listen to Articles and Get Summaries",
    excerpt:
      "Have any article read aloud, get a short summary before deciding whether to " +
      "read it, and choose your voices, models, and API keys.",
    markdown: `
Lion Reader can read articles aloud to you, and summarize them so you can decide what's worth your time. Both work without any setup.

## Listen to any article

Press **Listen** at the top of an article and Lion Reader reads it aloud, highlighting each paragraph as it goes. Tap a paragraph to jump there, change the speed, or put your phone away and control playback from your lock screen or headphones.

Choose your voice under [Settings → AI & Narration → Narration](/settings/ai#narration): cloud voices sound the most natural, downloaded voices run entirely on your device and work offline, and your browser's built-in voices need no setup at all. You can also have an AI model tidy up the text before it's read, so "Dr." is read as "Doctor" and "5 ms" as "5 milliseconds".

## Get a summary

Press **Summarize** on any article for a short overview of its main points, so you can decide whether it's worth your time. Summaries only run when you ask for one. Change their length, the model, or the instructions it follows under [Summaries](/settings/ai#summaries).

## Your own API key

Summaries and cloud voices work without any setup, within your plan's limits, which you can see under [Settings → Account → Plan](/settings#plan). If you run out, want models your plan doesn't include, or want AI text cleanup for narration on a plan that doesn't include it, add your own key from an AI provider like Anthropic or OpenRouter under [AI Provider API Keys](/settings/ai#ai-provider-keys). Calls on your own key don't count against your plan.

Don't want narration at all? Turn it off on the same page.
`.trim(),
  },
  {
    key: "mcp",
    title: "Connect an AI Assistant",
    excerpt:
      "Let Claude or another AI assistant read, search, save, and rank your articles " +
      "for you over MCP.",
    markdown: `
Connect Lion Reader to Claude or another AI assistant, and it can work with your reading the way you would. Just ask:

- "Give me a rundown of today's newsletters."
- "What did the blogs in my News tag post this week? Summarize anything about climate policy."
- "Score my unread articles by how much I'd want to read them."
- "Save this link for me to read later."
- "Write up what we just discussed and upload it to Lion Reader."

Your assistant can read, search, star, and save articles, upload articles it writes, mark things read, tag your subscriptions, and build collections. It can also do things the app leaves to it: give your articles scores, so sorting a list by score puts what it thinks you'll most want to read at the top, or put a collection in a sensible reading order.

## Connect

[Settings → Integrations → AI Integrations](/settings/integrations#ai-integrations) has copy-and-paste setup for Claude Code, Claude Desktop, and claude.ai. Any other assistant that supports [MCP](https://modelcontextprotocol.io/) can connect the same way.

Its access is limited to your reader, and you can revoke it at any time under [Settings → Security](/settings/security).
`.trim(),
  },
  {
    key: "get-involved",
    title: "Get Involved",
    excerpt:
      "Join our Discord, report bugs and request features on GitHub, and try our " +
      "native app before anyone else.",
    markdown: `
Lion Reader is built in the open, and what people ask for shapes what we work on next.

- **Join our [Discord server](${DISCORD_SERVER_URL})** to ask questions, suggest features, and hear about new ones first.
- **Report a bug or request a feature** on [GitHub](${LION_READER_ISSUES_URL}), or tell us with [this feedback form](${FEEDBACK_FORM_URL}).
- **Try the native Android app** before it's public: ${NATIVE_APP_BETA} to join the beta.
- **Read the code or run your own server.** Lion Reader is [open source](${LION_READER_REPO_URL}).

You can always reach us at [${CONTACT_EMAIL}](mailto:${CONTACT_EMAIL}).
`.trim(),
  },
  {
    key: "apps",
    title: "Lion Reader on Your Phone and Other Apps",
    excerpt:
      "Our native Android app beta, installing Lion Reader to your home screen, " +
      "and connecting RSS and read-it-later apps.",
    markdown: `
Lion Reader works on your phone, and with apps you may already use.

## Our Android app

Our native Android app is the best way to read on your phone: it's built for Lion Reader, works offline, and you can save to it from any app's share menu. It's in beta — ${NATIVE_APP_BETA} to try it. See [Settings → Integrations → Lion Reader App](/settings/integrations#native-app).

## Install Lion Reader from your browser

On any phone or computer, use your browser's "Install" or "Add to Home Screen" option. You get an app icon, and on Android, Lion Reader shows up in the share menu for saving links.

## Wallabag apps

The free Wallabag read-it-later apps for [Android](${WALLABAG_ANDROID_APP_URL}) and [iOS](${WALLABAG_IOS_APP_URL}) can save to Lion Reader from your share menu, without a Wallabag account. Scan the QR code under [Settings → Integrations → Wallabag API](/settings/integrations#wallabag-api) to connect one.

## Other RSS apps

Prefer an RSS app you already use, like Reeder Classic, NetNewsWire, or Read You? Connect it with the Google Reader API under [Settings → Integrations → Google Reader API](/settings/integrations#google-reader-api), and it syncs your feeds and read state with Lion Reader.

Wallabag apps and RSS apps sign in with your Lion Reader password. Signed up with Google, Apple, or Discord? Set a password first under [Settings → Account → Password](/settings#password).
`.trim(),
  },
];
