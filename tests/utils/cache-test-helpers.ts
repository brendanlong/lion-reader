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
import { addSubscriptionToCache } from "@/lib/cache/count-cache";
import type { SyncEvent } from "@/lib/events/schemas";
import type { AppRouter } from "@/server/trpc/root";
import type { TRPCClientUtils } from "@/lib/trpc/client";

// ============================================================================
// Types
// ============================================================================

export interface SeededSubscription {
  id: string;
  type: "web" | "email" | "saved";
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
  feedId: string;
  subscriptionId: string | null;
  type: "web" | "email" | "saved";
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
  score: number | null;
  implicitScore: number;
  siteName: string | null;
  predictedScore: number | null;
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
//   entry-saved:           null,  saved, unread, not starred (saved article, no subscription)
//   entry-starred-orphan:  null,  web, unread, starred (orphaned starred entry, no subscription)
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

export const DEFAULT_TAGS: SeededTag[] = [
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

export const DEFAULT_UNCATEGORIZED = { feedCount: 1, unreadCount: 3 };

export const DEFAULT_ENTRIES: SeededEntry[] = [
  {
    id: "entry-1",
    feedId: "feed-1",
    subscriptionId: "sub-1",
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
    score: null,
    implicitScore: 0,
    siteName: null,
    predictedScore: null,
  },
  {
    id: "entry-2",
    feedId: "feed-1",
    subscriptionId: "sub-1",
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
    score: null,
    implicitScore: 0,
    siteName: null,
    predictedScore: null,
  },
  {
    id: "entry-3",
    feedId: "feed-2",
    subscriptionId: "sub-2",
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
    score: null,
    implicitScore: 0,
    siteName: null,
    predictedScore: null,
  },
  {
    id: "entry-saved",
    feedId: "feed-saved",
    subscriptionId: null,
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
    score: null,
    implicitScore: 0,
    siteName: null,
    predictedScore: null,
  },
  {
    id: "entry-starred-orphan",
    feedId: "feed-orphan",
    subscriptionId: null,
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
    score: null,
    implicitScore: 0,
    siteName: null,
    predictedScore: null,
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

/**
 * Seeds the tRPC utils cache with default subscription, tag, and entry count data.
 */
export function seedCacheState(
  utils: TRPCClientUtils,
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

  // Seed subscriptions into the subscription lookup map
  for (const sub of subs) {
    addSubscriptionToCache(sub);
  }

  // Also seed subscriptions.list for tests that read it via utils
  setUtilsData(utils.subscriptions.list, undefined, { items: subs });

  // Seed tags.list
  setUtilsData(utils.tags.list, undefined, {
    items: tagItems,
    uncategorized,
  });

  // Seed entries.count for various filters
  setUtilsData(utils.entries.count, {}, { unread: allUnread });
  setUtilsData(utils.entries.count, { starredOnly: true }, { unread: starredUnread });
  setUtilsData(utils.entries.count, { type: "saved" }, { unread: savedUnread });

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

export function createNewEntryEvent(
  overrides: Partial<Extract<SyncEvent, { type: "new_entry" }>> = {}
): Extract<SyncEvent, { type: "new_entry" }> {
  return {
    type: "new_entry",
    subscriptionId: "sub-1",
    entryId: "new-entry-1",
    timestamp: defaultTimestamp,
    updatedAt: defaultTimestamp,
    feedType: "web",
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
    counts: {
      all: { unread: 0 },
      starred: { unread: 0 },
      subscriptions: [],
      tags: [],
    },
    timestamp: defaultTimestamp,
    updatedAt: defaultTimestamp,
    ...overrides,
  };
}

export function createSubscriptionCreatedEvent(
  overrides: Partial<Extract<SyncEvent, { type: "subscription_created" }>> = {}
): Extract<SyncEvent, { type: "subscription_created" }> {
  return {
    type: "subscription_created",
    subscriptionId: "sub-new",
    feedId: "feed-new",
    timestamp: defaultTimestamp,
    updatedAt: defaultTimestamp,
    subscription: {
      id: "sub-new",
      feedId: "feed-new",
      customTitle: null,
      subscribedAt: defaultTimestamp,
      unreadCount: 7,
      tags: [{ id: "tag-1", name: "Tech", color: "#ff0000" }],
    },
    feed: {
      id: "feed-new",
      type: "web",
      url: "https://example.com/new-feed.xml",
      title: "New Feed",
      description: "A new feed",
      siteUrl: "https://example.com",
    },
    ...overrides,
  };
}

export function createSubscriptionUpdatedEvent(
  overrides: Partial<Extract<SyncEvent, { type: "subscription_updated" }>> = {}
): Extract<SyncEvent, { type: "subscription_updated" }> {
  return {
    type: "subscription_updated",
    subscriptionId: "sub-1",
    tags: [{ id: "tag-2", name: "Science", color: "#00ff00" }],
    customTitle: null,
    timestamp: defaultTimestamp,
    updatedAt: defaultTimestamp,
    ...overrides,
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
