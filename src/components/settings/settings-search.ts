/**
 * Settings search: a hand-written index of every settings section and a
 * local, synchronous matcher over it. The index is small enough that scoring
 * every entry on each keystroke is instant, so there's no server round-trip.
 *
 * Keywords should cover the individual controls in the section and the words
 * a user might reach for instead of ours ("dark mode" for Theme).
 */

import { AI_PROVIDER_INFO } from "@/lib/ai/providers";

export const SETTINGS_PAGES = [
  { href: "/settings", label: "Account" },
  { href: "/settings/appearance", label: "Appearance" },
  { href: "/settings/subscriptions", label: "Subscriptions" },
  { href: "/settings/email", label: "Email" },
  { href: "/settings/ai", label: "AI & Narration" },
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings/feed-health", label: "Feed Health" },
  { href: "/settings/sessions", label: "Sessions" },
  { href: "/settings/connected-apps", label: "Connected Apps" },
  { href: "/settings/delete-account", label: "Delete Account" },
] as const;

type SettingsPageHref = (typeof SETTINGS_PAGES)[number]["href"];

interface SettingsSearchEntry {
  id: string;
  page: SettingsPageHref;
  title: string;
  description: string;
  keywords: readonly string[];
  /** Only shown when the server can store AI provider API keys. */
  requiresApiKeys?: boolean;
}

export const SETTINGS_SEARCH_INDEX = [
  {
    id: "account-info",
    page: "/settings",
    title: "Account Information",
    description: "Your email address, when you joined, and whether your email is verified.",
    keywords: ["email address", "member since", "verified", "user"],
  },
  {
    id: "linked-accounts",
    page: "/settings",
    title: "Linked Accounts",
    description: "Connect your account with third-party providers for easy sign-in.",
    keywords: ["google", "apple", "discord", "oauth", "sign in", "login", "link", "unlink", "sso"],
  },
  {
    id: "password",
    page: "/settings",
    title: "Password",
    description: "Change your password, or set one if you signed up with a linked account.",
    keywords: ["change password", "set password", "reset", "login", "security", "credentials"],
  },
  {
    id: "keyboard-shortcuts",
    page: "/settings",
    title: "Keyboard Shortcuts",
    description: "Enable keyboard shortcuts to navigate entries and perform actions quickly.",
    keywords: ["hotkeys", "keybindings", "keys", "vim", "navigation"],
  },
  {
    id: "privacy-legal",
    page: "/settings",
    title: "Privacy & Legal",
    description: "Learn more about how we collect, use, and protect your data.",
    keywords: ["privacy policy", "terms of service", "tos", "data", "gdpr"],
  },
  {
    id: "about",
    page: "/settings",
    title: "About",
    description: "Who made Lion Reader, the source code, and how to get in touch.",
    keywords: ["contact", "feedback", "support", "github", "source code", "help"],
  },
  {
    id: "theme",
    page: "/settings/appearance",
    title: "Theme",
    description: "Choose light, dark, e-paper, or follow your system.",
    keywords: ["color mode", "dark mode", "light mode", "night", "e-ink", "epaper", "auto"],
  },
  {
    id: "article-text",
    page: "/settings/appearance",
    title: "Article Text",
    description: "How article content is displayed in the entry view.",
    keywords: [
      "text size",
      "font size",
      "font family",
      "typeface",
      "zoom",
      "larger",
      "smaller",
      "alignment",
      "justify",
      "justified",
      "merriweather",
      "literata",
      "inter",
      "source sans",
      "readability",
    ],
  },
  {
    id: "entry-list",
    page: "/settings/appearance",
    title: "Entry List",
    description: "Controls how densely entries are packed in the article list.",
    keywords: ["list density", "compact", "comfortable", "spacing", "preview", "snippet", "cards"],
  },
  {
    id: "tags",
    page: "/settings/subscriptions",
    title: "Tags",
    description: "Create, rename, recolor, and delete the tags you organize subscriptions with.",
    keywords: ["folders", "categories", "labels", "organize", "color", "rename"],
  },
  {
    id: "import-export",
    page: "/settings/subscriptions",
    title: "Import / Export",
    description:
      "Move your subscriptions to or from another RSS reader with OPML, or export your library.",
    keywords: [
      "opml",
      "import feeds",
      "export feeds",
      "backup",
      "download",
      "upload",
      "migrate",
      "feedly",
      "zip",
      "library",
      "bookmarks",
    ],
  },
  {
    id: "ingest-addresses",
    page: "/settings/email",
    title: "Ingest Addresses",
    description: "Email addresses that turn newsletters sent to them into feed entries.",
    keywords: ["newsletters", "email subscriptions", "inbox", "forward", "substack", "address"],
  },
  {
    id: "spam",
    page: "/settings/email",
    title: "Show Spam Entries",
    description: "Display entries that were flagged as spam by our email provider.",
    keywords: ["spam", "junk", "filter", "newsletters", "preferences"],
  },
  {
    id: "blocked-senders",
    page: "/settings/email",
    title: "Blocked Senders",
    description: "Email senders you blocked when unsubscribing from their newsletter.",
    keywords: ["unblock", "block", "newsletters", "unsubscribe", "email"],
  },
  {
    id: "ai-provider-keys",
    page: "/settings/ai",
    title: "AI Provider API Keys",
    description:
      "Add an API key for an AI provider to enable summaries, narration processing, and cloud voices.",
    keywords: [
      ...Object.values(AI_PROVIDER_INFO).map((p) => p.displayName),
      "api key",
      "llm",
      "byok",
    ],
    requiresApiKeys: true,
  },
  {
    id: "summaries",
    page: "/settings/ai",
    title: "Summaries",
    description: "AI-powered article summaries: model, length, and prompt.",
    keywords: [
      "summarize",
      "summarization",
      "tldr",
      "model",
      "max words",
      "length",
      "custom prompt",
    ],
    requiresApiKeys: true,
  },
  {
    id: "ai-text-processing",
    page: "/settings/ai",
    title: "AI Text Processing",
    description: "Improve narration by expanding abbreviations and formatting content for speech.",
    keywords: ["narration model", "llm", "abbreviations", "normalization", "text to speech"],
    requiresApiKeys: true,
  },
  {
    id: "narration",
    page: "/settings/ai",
    title: "Narration",
    description: "Listen to articles using text-to-speech.",
    keywords: [
      "text to speech",
      "tts",
      "audio",
      "listen",
      "read aloud",
      "next article",
      "continue",
      "voice",
      "voices",
      "enhanced voices",
      "cloud voices",
      "speed",
      "rate",
      "pitch",
      "highlight paragraph",
      "auto-scroll",
    ],
  },
  {
    id: "save-to-lion-reader",
    page: "/settings/integrations",
    title: "Save to Lion Reader",
    description: "Save any webpage to read later with the browser extension or the bookmarklet.",
    keywords: [
      "bookmarklet",
      "browser extension",
      "firefox",
      "chrome",
      "safari",
      "read later",
      "save article",
      "clip",
    ],
  },
  {
    id: "google-reader-api",
    page: "/settings/integrations",
    title: "Google Reader API",
    description: "Sync with mobile and desktop RSS apps that support the Google Reader API.",
    keywords: [
      "freshrss",
      "reeder",
      "netnewswire",
      "focusreader",
      "read you",
      "newsflash",
      "mobile app",
      "sync",
      "client",
      "ios",
      "android",
    ],
  },
  {
    id: "wallabag-api",
    page: "/settings/integrations",
    title: "Wallabag API (Save Articles)",
    description: "Save articles from your phone with a Wallabag app.",
    keywords: [
      "wallabag",
      "read later",
      "mobile app",
      "android",
      "ios",
      "qr code",
      "share",
      "sign out apps",
    ],
  },
  {
    id: "ai-integrations",
    page: "/settings/integrations",
    title: "AI Integrations",
    description: "Connect Lion Reader to AI assistants like Claude via MCP.",
    keywords: ["mcp", "model context protocol", "claude", "claude code", "claude desktop", "agent"],
  },
  {
    id: "discord-bot",
    page: "/settings/integrations",
    title: "Discord Bot",
    description: "Save articles by reacting to Discord messages or sending links to the bot.",
    keywords: ["discord", "bot", "server", "react", "emoji", "dm"],
  },
  {
    id: "api-tokens",
    page: "/settings/integrations",
    title: "API Tokens",
    description: "Create and revoke tokens for MCP, browser extensions, and other API clients.",
    keywords: ["api key", "token", "personal access token", "revoke", "scopes", "developer"],
  },
  {
    id: "broken-feeds",
    page: "/settings/feed-health",
    title: "Broken Feeds",
    description: "Feeds that are failing to fetch, with their errors and a retry button.",
    keywords: ["errors", "failing", "not updating", "retry", "fix", "dead feeds"],
  },
  {
    id: "feed-statistics",
    page: "/settings/feed-health",
    title: "Feed Statistics",
    description: "When each feed was last fetched and will next be fetched.",
    keywords: ["stats", "fetch", "schedule", "websub", "last updated", "refresh"],
  },
  {
    id: "sessions",
    page: "/settings/sessions",
    title: "Active Sessions",
    description: "Devices signed in to your account. Sign out of the ones you don't recognize.",
    keywords: ["devices", "sign out", "log out", "logout", "revoke", "security", "browsers"],
  },
  {
    id: "connected-apps",
    page: "/settings/connected-apps",
    title: "Connected Apps",
    description: "Applications you've authorized to access your account.",
    keywords: ["oauth", "authorized", "third-party", "revoke", "permissions", "access"],
  },
  {
    id: "delete-account",
    page: "/settings/delete-account",
    title: "Delete Account",
    description: "Permanently delete your account and all of its data.",
    keywords: ["remove account", "close account", "deactivate", "erase", "data"],
  },
] as const satisfies readonly SettingsSearchEntry[];

export type SettingsSectionId = (typeof SETTINGS_SEARCH_INDEX)[number]["id"];
export type SettingsSearchResult = (typeof SETTINGS_SEARCH_INDEX)[number];

/** Words too common to require a match: "how do I change my password" → "change password". */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "can",
  "do",
  "for",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "where",
  "with",
]);

/** Field weights: a hit on the title says more than one in the description. */
const TITLE_WEIGHT = 8;
const KEYWORD_WEIGHT = 5;
const PAGE_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 2;

/** A whole-query phrase found in the title or a keyword, on top of the per-word score. */
const PHRASE_BONUS = 6;

/**
 * Drop matches scoring below this fraction of the best one, so a strong hit
 * isn't followed by a tail of typo matches ("theme" vs. "them").
 */
const MIN_RELATIVE_SCORE = 0.25;

/**
 * A query shorter than this prefix-matches most of the index, which would
 * mount (and start the queries of) nearly every section at once.
 */
export const MIN_QUERY_LENGTH = 2;

/** Shorter words are too easy to hit by accident with a typo or a substring. */
const MIN_SUBSTRING_LENGTH = 3;
const MIN_TYPO_LENGTH = 4;

function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function words(text: string): string[] {
  const normalized = normalize(text);
  return normalized === "" ? [] : normalized.split(" ");
}

function meaningfulWords(text: string): string[] {
  return words(text).filter((w) => !STOP_WORDS.has(w));
}

/** True when `a` and `b` differ by at most one insertion, deletion, substitution or adjacent swap. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  const restA = a.slice(i);
  const restB = b.slice(i);
  return (
    restA.slice(1) === restB.slice(1) ||
    restA.slice(1) === restB ||
    restA === restB.slice(1) ||
    (restA[0] === restB[1] && restA[1] === restB[0] && restA.slice(2) === restB.slice(2))
  );
}

/** How well a query word matches an indexed word, from 0 (no match) to 1 (exact). */
function wordMatch(query: string, word: string): number {
  if (word === query) return 1;
  if (word.startsWith(query)) return 0.8;
  if (query.length >= MIN_SUBSTRING_LENGTH && word.includes(query)) return 0.5;
  if (
    query.length >= MIN_TYPO_LENGTH &&
    // Compare against the word's prefix too, so a typo mid-typing ("pasw") still matches.
    (withinOneEdit(query, word) || withinOneEdit(query, word.slice(0, query.length)))
  ) {
    return 0.4;
  }
  return 0;
}

interface IndexedField {
  weight: number;
  words: string[];
}

interface IndexedEntry {
  entry: SettingsSearchResult;
  fields: IndexedField[];
  phrases: string[];
}

export const SETTINGS_PAGE_LABELS = new Map<string, string>(
  SETTINGS_PAGES.map((p) => [p.href, p.label])
);

const INDEXED: IndexedEntry[] = SETTINGS_SEARCH_INDEX.map((entry) => ({
  entry,
  fields: [
    { weight: TITLE_WEIGHT, words: words(entry.title) },
    { weight: KEYWORD_WEIGHT, words: entry.keywords.flatMap(words) },
    { weight: PAGE_WEIGHT, words: words(SETTINGS_PAGE_LABELS.get(entry.page) ?? "") },
    { weight: DESCRIPTION_WEIGHT, words: meaningfulWords(entry.description) },
  ],
  phrases: [entry.title, ...entry.keywords].map((p) => meaningfulWords(p).join(" ")),
}));

function scoreEntry(indexed: IndexedEntry, queryWords: string[], phrase: string): number {
  let total = 0;
  for (const queryWord of queryWords) {
    let best = 0;
    for (const field of indexed.fields) {
      for (const word of field.words) {
        best = Math.max(best, field.weight * wordMatch(queryWord, word));
      }
    }
    // Every query word has to match somewhere, so adding words narrows results.
    if (best === 0) return 0;
    total += best;
  }
  if (queryWords.length > 1 && indexed.phrases.some((p) => p.includes(phrase))) {
    total += PHRASE_BONUS;
  }
  return total;
}

/**
 * Settings sections matching `query`, best match first. Entries with equal
 * scores keep their index order, which follows the settings pages.
 */
export function searchSettings(
  query: string,
  options: { canConfigureApiKeys: boolean }
): SettingsSearchResult[] {
  if (normalize(query).length < MIN_QUERY_LENGTH) return [];
  const queryWords = meaningfulWords(query);
  if (queryWords.length === 0) return [];
  const phrase = queryWords.join(" ");

  return INDEXED.filter(
    ({ entry }) =>
      options.canConfigureApiKeys || !("requiresApiKeys" in entry && entry.requiresApiKeys)
  )
    .map((indexed) => ({ entry: indexed.entry, score: scoreEntry(indexed, queryWords, phrase) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .filter(({ score }, _, [best]) => score >= best.score * MIN_RELATIVE_SCORE)
    .map(({ entry }) => entry);
}
