/**
 * Demo Landing Page Data
 *
 * Tags and subscriptions are configured here.
 * Articles live in individual files under ./articles/.
 * Entry counts, lookup maps, and helper functions are generated automatically.
 */

import { type EntryArticleProps } from "@/components/entries/EntryArticle";
import { type EntryListData } from "@/lib/hooks";
import { DEMO_ARTICLES, type DemoArticle } from "./articles";

// ============================================================================
// Types
// ============================================================================

export type { DemoArticle } from "./articles";

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
  /** Pre-generated AI summary HTML for the summary card */
  summaryHtml: string;
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
// Subscription config (title + tag mapping)
// ============================================================================

const SUBSCRIPTION_CONFIG: Record<string, { title: string; tagId: string }> = {
  "feed-types": { title: "Feed Types", tagId: "features" },
  "reading-experience": { title: "Reading Experience", tagId: "features" },
  organization: { title: "Organization & Search", tagId: "features" },
  integrations: { title: "Integrations & Sync", tagId: "features" },
  "lion-reader": { title: "Lion Reader", tagId: "about" },
};

// ============================================================================
// Generated data
// ============================================================================

/** Count entries per subscription */
const entryCountBySubscription = new Map<string, number>();
for (const article of DEMO_ARTICLES) {
  entryCountBySubscription.set(
    article.subscriptionId,
    (entryCountBySubscription.get(article.subscriptionId) ?? 0) + 1
  );
}

/** Generated subscriptions with computed entry counts */
export const DEMO_SUBSCRIPTIONS: DemoSubscription[] = Object.entries(SUBSCRIPTION_CONFIG).map(
  ([id, config]) => ({
    id,
    title: config.title,
    tagId: config.tagId,
    entryCount: entryCountBySubscription.get(id) ?? 0,
  })
);

/** Convert an article to a full DemoEntry by deriving feedId, feedTitle, etc. */
function articleToEntry(article: DemoArticle): DemoEntry {
  const config = SUBSCRIPTION_CONFIG[article.subscriptionId];
  return {
    ...article,
    feedId: article.subscriptionId,
    fetchedAt: article.publishedAt,
    read: false,
    feedTitle: config?.title ?? null,
    siteName: null,
    summary: article.summary,
  };
}

/** All entries (unsorted) */
export const DEMO_ENTRIES: DemoEntry[] = DEMO_ARTICLES.map(articleToEntry);

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
