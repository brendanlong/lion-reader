/**
 * Test helpers for handleSyncEvent integration tests.
 *
 * Provides cache seeding, event factory functions, and QueryClient setup
 * for testing the full event → cache-state pipeline.
 */

import { QueryClient } from "@tanstack/react-query";
import { vi, type MockInstance } from "vitest";
import { createTRPCClient, httpLink } from "@trpc/client";
import { createTRPCQueryUtils } from "@trpc/react-query";
import superjson from "superjson";
import type { SyncEvent, SyncSubscription } from "@/lib/events/schemas";
import { SAVED_SUBSCRIPTION_LIST_INPUT } from "@/lib/queries/saved-subscription";
import type { UnreadCounts } from "@/lib/cache/operations";
import type { AppRouter } from "@/server/trpc/root";
import type { TRPCClientUtils } from "@/lib/trpc/client";
import type { EntryType } from "@/lib/entry-types";
import { getLocalDb } from "@/lib/local-db/local-db";
import { countKey, type CountedList } from "@/lib/local-db/counts";
import type { TagRow } from "@/lib/local-db/tags";
import type { SubscriptionRow } from "@/lib/local-db/subscriptions";

// ============================================================================
// Types
// ============================================================================

export interface SeededSubscription {
  id: string;
  type: EntryType;
  url: string | null;
  title: string | null;
  originalTitle: string | null;
  description: string | null;
  siteUrl: string | null;
  subscribedAt: Date;
  unreadCount: number;
  tags: Array<{ id: string; name: string; color: string | null }>;
  fetchFullContent: boolean;
}

export interface SeededTag {
  id: string;
  name: string;
  color: string | null;
  feedCount: number;
  unreadCount: number;
  createdAt: Date;
}

export interface SeededEntry {
  id: string;
  subscriptionId: string | null;
  subscriptionIds: string[];
  type: EntryType;
  url: string | null;
  title: string | null;
  author: string | null;
  summary: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  updatedAt: Date;
  read: boolean;
  starred: boolean;
  feedTitle: string | null;
  siteName: string | null;
}

// ============================================================================
// Default Seed Data
//
// Relationships between seed values:
//   tag-1 (Tech):    feedCount=2 (sub-1, sub-3), unreadCount=15 (sub-1:5 + sub-3:10)
//   tag-2 (Science): feedCount=1 (sub-3),        unreadCount=10 (sub-3:10)
//   uncategorized:   feedCount=1 (sub-2),         unreadCount=3  (sub-2:3)
//   All Articles:    unread=18 (sub-1:5 + sub-2:3 + sub-3:10)
//   Starred:         unread=2 (entry-1: web/starred/unread, entry-starred-orphan: web/starred/unread)
//   Saved:           unread=1 (entry-saved: saved/unread)
//
// Entry details:
//   entry-1:               sub-1, web, unread, starred
//   entry-2:               sub-1, web, unread, not starred
//   entry-3:               sub-2, web, read, not starred
//   entry-saved:           sub-saved, saved, unread, not starred (a saved article: the saved
//                          subscription is its origin and its one membership)
//   entry-starred-orphan:  null,  web, unread, starred (stands in for a starred entry from
//                          an unsubscribed feed: no active membership; the server would send
//                          the old subscription as origin, which no cached one matches)
// ============================================================================

export const DEFAULT_SUBSCRIPTIONS: SeededSubscription[] = [
  {
    id: "sub-1",
    type: "web",
    url: "https://example.com/feed1.xml",
    title: "Feed One",
    originalTitle: "Feed One",
    description: "First feed",
    siteUrl: "https://example.com",
    subscribedAt: new Date("2024-01-01"),
    unreadCount: 5,
    tags: [{ id: "tag-1", name: "Tech", color: "#ff0000" }],
    fetchFullContent: false,
  },
  {
    id: "sub-2",
    type: "web",
    url: "https://example.com/feed2.xml",
    title: "Feed Two",
    originalTitle: "Feed Two",
    description: "Second feed",
    siteUrl: "https://example.com",
    subscribedAt: new Date("2024-01-02"),
    unreadCount: 3,
    tags: [],
    fetchFullContent: false,
  },
  {
    id: "sub-3",
    type: "web",
    url: "https://example.com/feed3.xml",
    title: "Feed Three",
    originalTitle: "Feed Three",
    description: "Third feed",
    siteUrl: "https://example.com",
    subscribedAt: new Date("2024-01-03"),
    unreadCount: 10,
    tags: [
      { id: "tag-1", name: "Tech", color: "#ff0000" },
      { id: "tag-2", name: "Science", color: "#00ff00" },
    ],
    fetchFullContent: false,
  },
];

const DEFAULT_TAGS: SeededTag[] = [
  {
    id: "tag-1",
    name: "Tech",
    color: "#ff0000",
    feedCount: 2,
    unreadCount: 15,
    createdAt: new Date("2024-01-01"),
  },
  {
    id: "tag-2",
    name: "Science",
    color: "#00ff00",
    feedCount: 1,
    unreadCount: 10,
    createdAt: new Date("2024-01-01"),
  },
];

const DEFAULT_UNCATEGORIZED = { feedCount: 1, unreadCount: 3 };

/** The seeded user's saved subscription: the saved article's origin and membership. */
export const SEEDED_SAVED_SUBSCRIPTION_ID = "sub-saved";

/** A saved subscription as `subscriptions.list` lists it. */
export function savedSubscriptionRow(id: string): SeededSubscription {
  return {
    id,
    type: "saved",
    url: null,
    title: "Saved",
    originalTitle: "Saved",
    description: null,
    siteUrl: null,
    subscribedAt: new Date("2024-01-01"),
    unreadCount: 0,
    tags: [],
    fetchFullContent: false,
  };
}

export const DEFAULT_ENTRIES: SeededEntry[] = [
  {
    id: "entry-1",
    subscriptionId: "sub-1",
    subscriptionIds: ["sub-1"],
    type: "web",
    url: "https://example.com/1",
    title: "Old Title",
    author: "Author One",
    summary: "Summary one",
    publishedAt: new Date("2024-06-01"),
    fetchedAt: new Date("2024-06-01"),
    updatedAt: new Date("2024-06-01"),
    read: false,
    starred: true,
    feedTitle: "Feed One",
    siteName: null,
  },
  {
    id: "entry-2",
    subscriptionId: "sub-1",
    subscriptionIds: ["sub-1"],
    type: "web",
    url: "https://example.com/2",
    title: "Entry Two",
    author: "Author Two",
    summary: "Summary two",
    publishedAt: new Date("2024-06-02"),
    fetchedAt: new Date("2024-06-02"),
    updatedAt: new Date("2024-06-02"),
    read: false,
    starred: false,
    feedTitle: "Feed One",
    siteName: null,
  },
  {
    id: "entry-3",
    subscriptionId: "sub-2",
    subscriptionIds: ["sub-2"],
    type: "web",
    url: "https://example.com/3",
    title: "Entry Three",
    author: "Author Three",
    summary: "Summary three",
    publishedAt: new Date("2024-06-03"),
    fetchedAt: new Date("2024-06-03"),
    updatedAt: new Date("2024-06-03"),
    read: true,
    starred: false,
    feedTitle: "Feed Two",
    siteName: null,
  },
  {
    id: "entry-saved",
    subscriptionId: SEEDED_SAVED_SUBSCRIPTION_ID,
    subscriptionIds: [SEEDED_SAVED_SUBSCRIPTION_ID],
    type: "saved",
    url: "https://example.com/saved-article",
    title: "Saved Article",
    author: "Saved Author",
    summary: "A saved article",
    publishedAt: new Date("2024-06-04"),
    fetchedAt: new Date("2024-06-04"),
    updatedAt: new Date("2024-06-04"),
    read: false,
    starred: false,
    feedTitle: null,
    siteName: null,
  },
  {
    id: "entry-starred-orphan",
    subscriptionId: null,
    subscriptionIds: [],
    type: "web",
    url: "https://example.com/orphan",
    title: "Orphaned Starred Entry",
    author: "Orphan Author",
    summary: "Starred entry from unsubscribed feed",
    publishedAt: new Date("2024-06-05"),
    fetchedAt: new Date("2024-06-05"),
    updatedAt: new Date("2024-06-05"),
    read: false,
    starred: true,
    feedTitle: "Old Feed",
    siteName: null,
  },
];

// ============================================================================
// Cache Setup
// ============================================================================

/**
 * Creates a QueryClient with seeded entry list data in the infinite query format
 * that tRPC uses: [["entries", "list"], { input: {...}, type: "infinite" }].
 */
export function createSeededQueryClient(entries: SeededEntry[] = DEFAULT_ENTRIES): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  // Seed the "All entries" infinite query (no filters)
  queryClient.setQueryData([["entries", "list"], { input: { limit: 25 }, type: "infinite" }], {
    pages: [{ items: entries, nextCursor: undefined }],
    pageParams: [undefined],
  });

  return queryClient;
}

/**
 * Builds a REAL tRPC query-utils object over a real QueryClient — the same
 * `useUtils()` surface the app uses — so cache helpers exercise genuine React
 * Query key hashing and structural sharing instead of a hand-rolled fake.
 *
 * `createTRPCQueryUtils` requires a vanilla client, but it is never exercised:
 * only fetch/prefetch/ensureData hit the link, and cache unit tests call solely
 * setData/getData/invalidate/cancel. The link throws so any accidental network
 * call fails loudly instead of hanging.
 */
export function createRealTrpcUtils(queryClient: QueryClient): TRPCClientUtils {
  const client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "http://cache-tests.invalid/trpc",
        transformer: superjson,
        fetch: () => {
          throw new Error("Cache unit tests must not make tRPC network calls");
        },
      }),
    ],
  });
  // createTRPCQueryUtils and useUtils expose the same setData/getData/invalidate
  // surface over the same QueryClient; only the static brand differs.
  return createTRPCQueryUtils<AppRouter>({ queryClient, client }) as unknown as TRPCClientUtils;
}

/** Spies on the QueryClient's invalidations so tests can assert what was invalidated. */
export function spyOnInvalidate(queryClient: QueryClient): MockInstance {
  return vi.spyOn(queryClient, "invalidateQueries");
}

export interface InvalidatedQuery {
  /** tRPC procedure path, e.g. "tags.list". */
  path: string;
  /** The query input, when the invalidation targeted a specific input. */
  input: unknown;
}

/**
 * Reads the invalidations captured by {@link spyOnInvalidate}. Every invalidation
 * (whether via `utils.x.y.invalidate()` or a direct `queryClient.invalidateQueries`)
 * uses the tRPC key shape `[["router","procedure"], { input?, type? }]`.
 */
export function invalidatedQueries(spy: MockInstance): InvalidatedQuery[] {
  return (spy.mock.calls as unknown[][])
    .map((call) => {
      const filters = call[0] as { queryKey?: unknown } | undefined;
      const key = filters?.queryKey as [unknown, { input?: unknown }?] | undefined;
      const path = Array.isArray(key?.[0]) ? (key![0] as string[]).join(".") : undefined;
      return path ? { path, input: key?.[1]?.input } : undefined;
    })
    .filter((q): q is InvalidatedQuery => q !== undefined);
}

/** Convenience: the set of tRPC procedure paths that were invalidated. */
export function invalidatedProcedures(spy: MockInstance): string[] {
  return invalidatedQueries(spy).map((q) => q.path);
}

/**
 * Writes a value into the real tRPC query cache. Test fixtures approximate the
 * server output shape, so the value is cast at this single boundary rather than
 * constructing full router-output types.
 */
export function setUtilsData(node: unknown, input: unknown, data: unknown): void {
  (node as { setData: (i: unknown, d: unknown) => void }).setData(input, data);
}

/** Reads a value from the real tRPC query cache (typed by the caller). */
export function getUtilsData<T>(node: unknown, input?: unknown): T | undefined {
  return (node as { getData: (i?: unknown) => unknown }).getData(input) as T | undefined;
}

type SetInfiniteData = (input: unknown, data: unknown) => void;

/** The unread count the store holds for a list. */
export function storedCount(
  queryClient: QueryClient,
  list: CountedList = { all: true }
): { unread: number } | undefined {
  const row = getLocalDb(queryClient).counts.rows.getSynced(countKey(list));
  return row && { unread: row.unread };
}

/** The stored tags and their counts, in `tags.list`'s shape (undefined before any loaded). */
export function storedTagsList(queryClient: QueryClient):
  | {
      items: Array<TagRow & { unreadCount: number }>;
      uncategorized: { unreadCount: number | undefined };
    }
  | undefined {
  const db = getLocalDb(queryClient);
  const tags = db.tags.rows.allSynced();
  const unread = (key: string) => db.counts.rows.getSynced(key)?.unread;
  const uncategorized = unread(countKey({ uncategorized: true }));
  if (tags.length === 0 && uncategorized === undefined) return undefined;
  return {
    items: tags
      .map((tag) => ({ ...tag, unreadCount: unread(countKey({ tagId: tag.id })) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    uncategorized: { unreadCount: uncategorized },
  };
}

/**
 * Seeds the tRPC utils cache with default subscription, tag, and entry count data.
 */
export function seedCacheState(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  options: {
    subscriptions?: SeededSubscription[];
    tags?: SeededTag[];
    uncategorized?: { feedCount: number; unreadCount: number };
    allUnread?: number;
    starredUnread?: number;
    savedUnread?: number;
    entries?: Array<{ id: string; entry: SeededEntry }>;
  } = {}
): void {
  const subs = options.subscriptions ?? DEFAULT_SUBSCRIPTIONS;
  const tagItems = options.tags ?? DEFAULT_TAGS;
  const uncategorized = options.uncategorized ?? DEFAULT_UNCATEGORIZED;
  const allUnread = options.allUnread ?? 18;
  const starredUnread = options.starredUnread ?? 2;
  const savedUnread = options.savedUnread ?? 1;

  // Seed the sidebar's per-tag / uncategorized subscriptions.list pages, which
  // the local store ingests
  const seedSidebarList = (input: { tagId: string } | { uncategorized: true }, items: unknown[]) =>
    (utils.subscriptions.list as unknown as { setInfiniteData: SetInfiniteData }).setInfiniteData(
      { ...input, limit: 50 },
      {
        pages: [{ items, nextCursor: undefined }],
        pageParams: [undefined],
      }
    );
  for (const tag of tagItems) {
    seedSidebarList(
      { tagId: tag.id },
      subs.filter((sub) => sub.tags.some((t) => t.id === tag.id))
    );
  }
  seedSidebarList(
    { uncategorized: true },
    subs.filter((sub) => sub.tags.length === 0)
  );
  // The layout's prefetch, which lists the saved subscription
  setUtilsData(utils.subscriptions.list, SAVED_SUBSCRIPTION_LIST_INPUT, {
    items: [savedSubscriptionRow(SEEDED_SAVED_SUBSCRIPTION_ID)],
  });

  // Seed tags.list
  setUtilsData(utils.tags.list, undefined, {
    items: tagItems,
    uncategorized,
  });

  setUtilsData(utils.entries.countLists, undefined, {
    all: allUnread,
    starred: starredUnread,
    saved: savedUnread,
    uncategorized: uncategorized.unreadCount,
  });

  // Seed individual entry caches (entries.get) — seed all entries by default
  // so tests can verify entries.get fallback behavior
  const entriesToSeed =
    options.entries ?? DEFAULT_ENTRIES.map((entry) => ({ id: entry.id, entry }));
  for (const { id, entry } of entriesToSeed) {
    setUtilsData(utils.entries.get, { id }, { entry });
  }
}

// ============================================================================
// Event Factories
// ============================================================================

const defaultTimestamp = "2024-07-01T00:00:00.000Z";

/** The `countsAsOfSchema` stamp of every count the factories build. */
const defaultCountsAsOf = "2024-07-01T00:00:00.000000Z";

type CountsOverrides = Partial<Omit<UnreadCounts, "subscriptions">> & {
  subscriptions?: Array<{ id: string; unread: number; tagIds?: string[] }>;
};

/** Absolute counts as the server sends them; a subscription without `tagIds` is untagged. */
export function createCounts({
  subscriptions = [],
  ...overrides
}: CountsOverrides = {}): UnreadCounts {
  return {
    all: { unread: 0 },
    starred: { unread: 0 },
    saved: { unread: 0 },
    tags: [],
    asOf: defaultCountsAsOf,
    ...overrides,
    subscriptions: subscriptions.map(({ tagIds = [], ...sub }) => ({ ...sub, tagIds })),
  };
}

export function createNewEntryEvent(
  overrides: Partial<Extract<SyncEvent, { type: "new_entry" }>> = {}
): Extract<SyncEvent, { type: "new_entry" }> {
  return {
    type: "new_entry",
    subscriptionId: "sub-1",
    // A new entry's one membership is its origin.
    subscriptionIds: overrides.subscriptionId === null ? [] : [overrides.subscriptionId ?? "sub-1"],
    entryId: "new-entry-1",
    timestamp: defaultTimestamp,
    updatedAt: defaultTimestamp,
    ...overrides,
  };
}

export function createEntryUpdatedEvent(
  overrides: Partial<Extract<SyncEvent, { type: "entry_updated" }>> = {}
): Extract<SyncEvent, { type: "entry_updated" }> {
  return {
    type: "entry_updated",
    subscriptionId: "sub-1",
    entryId: "entry-1",
    timestamp: defaultTimestamp,
    updatedAt: defaultTimestamp,
    metadata: {
      title: "Updated Title",
      author: "Updated Author",
      summary: "Updated Summary",
      url: "https://example.com/updated",
      publishedAt: "2024-07-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

export function createEntryStateChangedEvent(
  overrides: Partial<Extract<SyncEvent, { type: "entry_state_changed" }>> = {}
): Extract<SyncEvent, { type: "entry_state_changed" }> {
  return {
    type: "entry_state_changed",
    entryId: "entry-1",
    read: true,
    starred: true,
    counts: createCounts(),
    subscriptionIds: ["sub-1"],
    timestamp: defaultTimestamp,
    updatedAt: defaultTimestamp,
    ...overrides,
  };
}

export function createMarkAllReadEvent(
  overrides: Partial<Extract<SyncEvent, { type: "mark_all_read" }>> = {}
): Extract<SyncEvent, { type: "mark_all_read" }> {
  return {
    type: "mark_all_read",
    timestamp: defaultTimestamp,
    updatedAt: defaultTimestamp,
    entryId: "entry-1",
    counts: createCounts(),
    ...overrides,
  };
}

/** A subscription as subscription events carry it: by default, the seeded `sub-1`. */
function createSyncSubscription(overrides: Partial<SyncSubscription> = {}): SyncSubscription {
  const { subscribedAt, ...seeded } = DEFAULT_SUBSCRIPTIONS[0];
  return {
    ...seeded,
    subscribedAt: subscribedAt.toISOString(),
    unreadCountAsOf: defaultCountsAsOf,
    ...overrides,
  };
}

/** A subscription_created event for a new subscription (`sub-new` by default). */
export function createSubscriptionCreatedEvent(
  subscription: Partial<SyncSubscription> = {},
  overrides: Partial<Extract<SyncEvent, { type: "subscription_created" }>> = {}
): Extract<SyncEvent, { type: "subscription_created" }> {
  const row = createSyncSubscription({
    id: "sub-new",
    url: "https://example.com/new-feed.xml",
    title: "New Feed",
    originalTitle: "New Feed",
    subscribedAt: defaultTimestamp,
    unreadCount: 7,
    ...subscription,
  });
  return {
    type: "subscription_created",
    subscriptionId: row.id,
    timestamp: defaultTimestamp,
    updatedAt: defaultTimestamp,
    row,
    subscription: {
      id: row.id,
      customTitle: row.title,
      subscribedAt: row.subscribedAt,
      unreadCount: row.unreadCount,
      tags: row.tags,
      fetchFullContent: row.fetchFullContent,
    },
    feed: {
      type: row.type,
      url: row.url,
      title: row.originalTitle,
      description: row.description,
      siteUrl: row.siteUrl,
    },
    ...overrides,
  };
}

/** A subscription as `subscriptions.get`/`update`/`setTags` return it. */
export function createSubscriptionRow(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  const id = overrides.id ?? "sub-1";
  return {
    id,
    type: "web",
    url: `https://example.com/${id}.xml`,
    title: id,
    originalTitle: id,
    description: null,
    siteUrl: null,
    subscribedAt: new Date("2024-01-01T00:00:00Z"),
    unreadCount: 0,
    tags: [],
    fetchFullContent: false,
    ...overrides,
  };
}

/** A subscription_updated event for the seeded `sub-1` by default. */
export function createSubscriptionUpdatedEvent(
  subscription: Partial<SyncSubscription> = {}
): Extract<SyncEvent, { type: "subscription_updated" }> {
  const row = createSyncSubscription({
    tags: [{ id: "tag-2", name: "Science", color: "#00ff00" }],
    ...subscription,
  });
  return {
    type: "subscription_updated",
    subscriptionId: row.id,
    row,
    tags: row.tags,
    customTitle: row.title,
    fetchFullContent: row.fetchFullContent,
    timestamp: defaultTimestamp,
    updatedAt: defaultTimestamp,
  };
}

export function createSubscriptionDeletedEvent(
  overrides: Partial<Extract<SyncEvent, { type: "subscription_deleted" }>> = {}
): Extract<SyncEvent, { type: "subscription_deleted" }> {
  return {
    type: "subscription_deleted",
    subscriptionId: "sub-1",
    timestamp: defaultTimestamp,
    updatedAt: defaultTimestamp,
    ...overrides,
  };
}

export function createTagCreatedEvent(
  overrides: Partial<Extract<SyncEvent, { type: "tag_created" }>> = {}
): Extract<SyncEvent, { type: "tag_created" }> {
  return {
    type: "tag_created",
    tag: { id: "tag-new", name: "New Tag", color: "#0000ff" },
    timestamp: defaultTimestamp,
    updatedAt: defaultTimestamp,
    ...overrides,
  };
}

export function createTagUpdatedEvent(
  overrides: Partial<Extract<SyncEvent, { type: "tag_updated" }>> = {}
): Extract<SyncEvent, { type: "tag_updated" }> {
  return {
    type: "tag_updated",
    tag: { id: "tag-1", name: "Technology", color: "#ff00ff" },
    timestamp: defaultTimestamp,
    updatedAt: defaultTimestamp,
    ...overrides,
  };
}

export function createTagDeletedEvent(
  overrides: Partial<Extract<SyncEvent, { type: "tag_deleted" }>> = {}
): Extract<SyncEvent, { type: "tag_deleted" }> {
  return {
    type: "tag_deleted",
    tagId: "tag-1",
    timestamp: defaultTimestamp,
    updatedAt: defaultTimestamp,
    ...overrides,
  };
}

export function createImportProgressEvent(
  overrides: Partial<Extract<SyncEvent, { type: "import_progress" }>> = {}
): Extract<SyncEvent, { type: "import_progress" }> {
  return {
    type: "import_progress",
    importId: "import-1",
    feedUrl: "https://example.com/feed.xml",
    feedStatus: "imported",
    imported: 5,
    skipped: 0,
    failed: 0,
    total: 10,
    timestamp: defaultTimestamp,
    updatedAt: defaultTimestamp,
    ...overrides,
  };
}
