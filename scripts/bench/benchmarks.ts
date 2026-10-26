/**
 * The database benchmarks: the SQL a service function sends for one user
 * action, against the seeded dataset (`seed.ts`), recorded by running the
 * function (`recordStatements`). A write replays its statements in order, with
 * the ids and times the recording generated, inside a transaction that is
 * rolled back (`run.ts`), so every iteration starts from the same data.
 */

import type { ClientBase } from "pg";

import { eq } from "drizzle-orm";

import { db as appDb } from "@/server/db";
import { feeds, type Feed } from "@/server/db/schema";
import { processInboundEmail } from "@/server/email/process-inbound";
import {
  generateContentHash,
  processEntries,
  updateEntryContent,
} from "@/server/feed/entry-processor";
import type { ParsedEntry } from "@/server/feed/types";
import { addEntriesToCollection } from "@/server/services/collections";
import {
  countUserLists,
  listEntries,
  listGreaderItemRefs,
  type ListEntriesParams,
} from "@/server/services/entries";
import { getEntries, getFullEntry } from "@/server/services/entry-reads";
import { setEntryScores } from "@/server/services/entry-scores";
import {
  markAllEntriesRead,
  markEntriesRead,
  updateEntriesStarred,
} from "@/server/services/entry-state";
import { listEntryTagLists } from "@/server/services/entry-tag-lists";
import { collectSyncChanges, collectSyncEvents, currentSyncCursors } from "@/server/services/sync";
import { deleteSavedArticle, saveArticle } from "@/server/services/saved";
import { createSubscription, mergeSubscriptionIntoFeed } from "@/server/services/subscribe";
import { unsubscribe } from "@/server/services/subscription-updates";
import { getSubscription } from "@/server/services/subscriptions";
import { listTags } from "@/server/services/tags";
import { getGreaderUnreadCounts } from "@/server/google-reader/subscriptions";
import {
  isStreamError,
  resolveStreamListParams,
  STREAM_CONTENTS_PAGE,
  STREAM_ITEM_IDS_PAGE,
} from "@/server/google-reader/stream-filters";
import { listWallabagEntries } from "@/server/wallabag/entries";
import { parseEntryListParams } from "@/server/wallabag/parse";
import { Temporal } from "temporal-polyfill";
import { recordStatements } from "./record";

import {
  COLLECTIONS,
  FEED_ITEM_COLUMNS,
  U0,
  U0_INGEST_TOKEN,
  SPARSE_TAG,
  U_KEEPS_UP,
  WEB,
  collectionSubscriptionId,
  feedItem,
  prng,
  savedSubscriptionId,
  searchQuery,
  tagId,
  userId,
  vocabulary,
  webFeedId,
  webFeedUrl,
  webSubscriptionId,
} from "./dataset";

export interface Statement {
  /** Short name, unique within the benchmark (e.g. "update", "counts.users"). */
  label: string;
  sql: string;
  params?: unknown[];
}

export interface PreparedBenchmark {
  statements: Statement[];
}

export interface Benchmark {
  name: string;
  kind: "read" | "write";
  /** The service function(s) whose SQL this records. */
  source: string;
  /** Resolves ids from the seeded data and builds the statements, once per run. */
  prepare: (db: ClientBase) => Promise<PreparedBenchmark>;
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/** A SQL literal for a string, number, boolean or null. */
function q(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

async function rows<T>(db: ClientBase, sql: string): Promise<T[]> {
  return (await db.query<T & Record<string, unknown>>(sql)).rows;
}

async function one<T>(db: ClientBase, sql: string): Promise<T> {
  const [row] = await rows<T>(db, sql);
  if (!row) throw new Error(`benchmark setup query returned no rows:\n${sql}`);
  return row;
}

/** HTML for a new article: `paragraphs` paragraphs of made-up words. */
function articleHtml(seed: number, paragraphs: number): { title: string; html: string } {
  const rand = prng(seed);
  const vocab = vocabulary();
  const word = () => vocab[Math.floor(5000 * rand() ** 3)];
  const paragraph = () => Array.from({ length: 40 + Math.floor(rand() * 100) }, word).join(" ");
  const paras = Array.from({ length: paragraphs }, paragraph);
  return {
    title: Array.from({ length: 6 }, word).join(" "),
    html: paras.map((p) => `<p>${p}.</p>`).join("\n"),
  };
}

const subA = webSubscriptionId(0, WEB.markAll);
const subMostlyRead = webSubscriptionId(0, WEB.mostlyRead);
const subLarge = webSubscriptionId(0, WEB.large);
const subMergeSource = webSubscriptionId(0, WEB.mergeSource);
const readingList = collectionSubscriptionId(0, COLLECTIONS.readingList.key);
const emptyCollection = collectionSubscriptionId(0, COLLECTIONS.empty.key);
const archive = collectionSubscriptionId(1, COLLECTIONS.archive.key);

/** Whether `alias` (with user_id and entry_id) is in one of its user's collections. */
const inCollection = (alias: string, entryColumn: string) => `EXISTS (
    SELECT 1 FROM subscription_entries ce JOIN subscriptions cs ON cs.id = ce.subscription_id
    WHERE cs.type = 'collection' AND ce.user_id = ${alias}.user_id AND ce.entry_id = ${alias}.${entryColumn})`;

/** U0's newest unread web entry in a tagged subscription and no collection. */
async function plainUnreadEntry(db: ClientBase): Promise<{ id: string; subscription_id: string }> {
  return one(
    db,
    `SELECT ue.entry_id AS id, s.id AS subscription_id FROM user_entries ue
JOIN subscription_entries se ON se.user_id = ue.user_id AND se.entry_id = ue.entry_id
JOIN subscriptions s ON s.id = se.subscription_id AND s.unsubscribed_at IS NULL AND s.type = 'web'
WHERE ue.user_id = ${q(U0)} AND NOT ue.read AND NOT ue.starred AND NOT ue.is_spam
  AND EXISTS (SELECT 1 FROM subscription_tags st WHERE st.subscription_id = s.id)
  AND NOT ${inCollection("ue", "entry_id")}
ORDER BY ue.published_or_fetched_at DESC, ue.entry_id DESC LIMIT 1`
  );
}

/** U0's `n` newest visible entries not in any collection. */
async function newestVisibleIds(db: ClientBase, n: number): Promise<string[]> {
  return (
    await rows<{ id: string }>(
      db,
      `SELECT ve.id FROM visible_entries ve
WHERE ve.user_id = ${q(U0)}
  AND NOT ${inCollection("ve", "id")}
ORDER BY ve.published_or_fetched_at DESC, ve.id DESC LIMIT ${n}`
    )
  ).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** A list page as the web app requests it (`entries.list`): unread, 10 a page. */
const appList = (params: Partial<ListEntriesParams> = {}): ListEntriesParams => ({
  userId: U0,
  unreadOnly: true,
  limit: 10,
  showSpam: false,
  ...params,
});

/** How deep the deep-page benchmarks start. */
const DEEP_ROWS = 500;

/** The list's params with a cursor `depth` rows into it, paged with the app's own query. */
async function deep(params: ListEntriesParams, depth = DEEP_ROWS): Promise<ListEntriesParams> {
  let cursor: string | undefined;
  for (let read = 0; read < depth; read += 100) {
    const page = await listEntries(appDb, {
      ...params,
      limit: Math.min(100, depth - read),
      cursor,
    });
    if (!page.nextCursor) throw new Error(`list shorter than ${depth}: ${JSON.stringify(params)}`);
    cursor = page.nextCursor;
  }
  return { ...params, cursor };
}

/** A read benchmark of one `listEntries` page. */
function listBenchmark(
  name: string,
  source: string,
  params: (db: ClientBase) => Promise<ListEntriesParams>
): Benchmark {
  return {
    name,
    kind: "read",
    source: `services/entries.ts listEntries (${source})`,
    prepare: async (db) => {
      const resolved = await params(db);
      return { statements: await recordStatements("list", (app) => listEntries(app, resolved)) };
    },
  };
}

/** A web subscription of U0's, unread and 500+ entries long. */
async function longSubscription(db: ClientBase): Promise<string> {
  return (
    await one<{ id: string }>(
      db,
      `SELECT id FROM subscriptions WHERE user_id = ${q(U0)} AND unsubscribed_at IS NULL
ORDER BY unread_count DESC, id LIMIT 1`
    )
  ).id;
}

/** The sync cursors `back` changes before U0's newest, as a client would hold them. */
async function syncCursors(db: ClientBase, back: number) {
  // As the app sends them: Temporal's ISO form, microseconds kept.
  const iso = (col: string) => `to_json(${col}) #>> '{}'`;
  const instant = (ts: string) => Temporal.Instant.from(ts).toString();
  const entries = await one<{ ts: string; id: string }>(
    db,
    `SELECT ${iso("changed_at")} AS ts, entry_id AS id FROM user_entries WHERE user_id = ${q(U0)}
ORDER BY changed_at DESC, entry_id DESC OFFSET ${back} LIMIT 1`
  );
  const subscriptions = await one<{ ts: string }>(
    db,
    `SELECT ${iso("updated_at")} AS ts FROM subscriptions WHERE user_id = ${q(U0)}
ORDER BY updated_at DESC OFFSET 5 LIMIT 1`
  );
  const tags = await one<{ ts: string }>(
    db,
    `SELECT ${iso("max(updated_at)")} AS ts FROM tags WHERE user_id = ${q(U0)}`
  );
  return {
    entries: instant(entries.ts),
    entriesAfterId: entries.id,
    subscriptions: instant(subscriptions.ts),
    tags: instant(tags.ts),
  };
}

/** A Google Reader stream read: the route's `resolveStreamListParams`, then its page. */
async function greaderStream(
  streamId: string,
  query: Record<string, string>,
  page: { defaultCount: number; maxCount: number },
  withContents: boolean
): Promise<Statement[]> {
  return recordStatements("stream", async (app) => {
    const params = await resolveStreamListParams(
      app,
      { id: U0, showSpam: false },
      streamId,
      new URLSearchParams(query),
      page
    );
    if (isStreamError(params)) throw new Error(`${streamId}: ${params.message}`);
    const refs = await listGreaderItemRefs(app, params);
    if (withContents) {
      await getEntries(
        app,
        U0,
        refs.items.map((ref) => ref.id)
      );
    }
  });
}

/** The Wallabag entries route (`listWallabagEntries`) for the query string `query`. */
function wallabagEntries(query: Record<string, string>): Promise<Statement[]> {
  const url = new URL(
    `https://bench.invalid/api/wallabag/api/entries?${new URLSearchParams(query)}`
  );
  return recordStatements("wallabag", (app) =>
    listWallabagEntries(app, U0, parseEntryListParams(url))
  );
}

const READS: Benchmark[] = [
  {
    name: "ssr.tags_list",
    kind: "read",
    source: "services/tags.ts listTags",
    prepare: async () => ({
      statements: await recordStatements("tags", (app) => listTags(app, U0)),
    }),
  },
  {
    name: "ssr.entries_count",
    kind: "read",
    source: "services/entries.ts countUserLists (entries.countLists, once per SSR)",
    prepare: async () => ({
      statements: await recordStatements("counts", (app) => countUserLists(app, U0)),
    }),
  },
  {
    name: "ssr.sync_cursors",
    kind: "read",
    source: "services/sync.ts currentSyncCursors",
    prepare: async () => ({
      statements: await recordStatements("cursors", (app) => currentSyncCursors(app, U0)),
    }),
  },
  listBenchmark("ssr.list_all", "/all, unread, first page", async () => appList()),
  listBenchmark("ssr.list_all_page_20", "/all, unread, keyset cursor 200 rows deep", async () =>
    deep(appList(), 200)
  ),
  listBenchmark(
    "ssr.list_subscription",
    "/subscription/:id, U0's subscription with most unread",
    async (db) => appList({ subscriptionId: await longSubscription(db) })
  ),
  listBenchmark("ssr.list_tag", "/tag/:id; the tag also holds a collection", async () =>
    appList({ tagId: tagId(0, 1) })
  ),
  listBenchmark("ssr.list_starred", "/starred", async () => appList({ starredOnly: true })),
  listBenchmark("ssr.list_saved", "/saved", async () => appList({ type: "saved" })),
  listBenchmark(
    "ssr.list_uncategorized",
    "/uncategorized; includes untagged collections",
    async () => appList({ uncategorized: true })
  ),
  listBenchmark("ssr.list_recently_read", "/recently-read", async () =>
    appList({ unreadOnly: false, sortBy: "readChanged" })
  ),
  listBenchmark("list.sparse_tag", "/tag/:id, a tag of one quiet feed (#1946)", async () =>
    appList({ tagId: tagId(0, SPARSE_TAG) })
  ),
  listBenchmark("list.subscription_deep", `/subscription/:id, ${DEEP_ROWS} rows deep`, async (db) =>
    deep(appList({ subscriptionId: await longSubscription(db) }))
  ),
  listBenchmark("list.tag_deep", `/tag/:id, ${DEEP_ROWS} rows deep`, async () =>
    deep(appList({ tagId: tagId(0, 1) }))
  ),
  listBenchmark("list.uncategorized_deep", `/uncategorized, ${DEEP_ROWS} rows deep`, async () =>
    deep(appList({ uncategorized: true }))
  ),
  listBenchmark("list.starred_deep", `/starred, all, ${DEEP_ROWS} rows deep`, async () =>
    deep(appList({ starredOnly: true, unreadOnly: false }))
  ),
  listBenchmark("list.recently_read_deep", `/recently-read, ${DEEP_ROWS} rows deep`, async () =>
    deep(appList({ unreadOnly: false, sortBy: "readChanged" }))
  ),
  // Seeded scores are U0's newest 2,000 articles; the reading list is positioned.
  listBenchmark("list.score", "/all, unread, by score (#2064)", async () =>
    appList({ sortBy: "score" })
  ),
  listBenchmark("list.score_lowest", "/all, unread, by score, lowest first", async () =>
    appList({ sortBy: "score", sortOrder: "lowest" })
  ),
  listBenchmark("list.score_unscored_deep", "/all, unread, by score, 2,500 rows deep", async () =>
    deep(appList({ sortBy: "score" }), 2500)
  ),
  listBenchmark(
    "list.score_unscored_first",
    "/all, unread, by score, the page where the scored rows run out",
    async (db) => {
      const { n } = await one<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM visible_entries
WHERE user_id = ${q(U0)} AND NOT read AND NOT is_spam AND score IS NOT NULL`
      );
      return deep(appList({ sortBy: "score" }), n - 5);
    }
  ),
  listBenchmark("list.score_tag", "/tag/:id, by score", async () =>
    appList({ tagId: tagId(0, 1), sortBy: "score" })
  ),
  listBenchmark("list.all_show_spam", "/all, unread, showSpam", async () =>
    appList({ showSpam: true })
  ),
  listBenchmark("list.recently_read_show_spam", "/recently-read, showSpam", async () =>
    appList({ unreadOnly: false, sortBy: "readChanged", showSpam: true })
  ),
  listBenchmark(
    "list.collection_position",
    "/subscription/:id for a collection, by position",
    async () => appList({ subscriptionId: readingList, sortBy: "position" })
  ),
  listBenchmark(
    "list.collection_position_last",
    "/subscription/:id for a collection, by position, its last page",
    async (db) => {
      const { n } = await one<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM subscription_entries
WHERE subscription_id = ${q(readingList)} AND NOT read`
      );
      return deep(appList({ subscriptionId: readingList, sortBy: "position" }), n - 5);
    }
  ),
  {
    name: "ssr.entries_get",
    kind: "read",
    source: "services/entry-reads.ts getFullEntry (entries.get)",
    prepare: async (db) => {
      const { id } = await plainUnreadEntry(db);
      return { statements: await recordStatements("get", (app) => getFullEntry(app, U0, id)) };
    },
  },
  {
    name: "sse.new_entry_tag_lists",
    kind: "read",
    source:
      "services/entry-tag-lists.ts listEntryTagLists, per subscriber and new_entry (realtime/sse-connection.ts)",
    prepare: async (db) => {
      const { id } = await plainUnreadEntry(db);
      return {
        statements: await recordStatements("tag lists", (app) => listEntryTagLists(app, U0, [id])),
      };
    },
  },
  {
    name: "ssr.subscriptions_get",
    kind: "read",
    source: "services/subscriptions.ts getSubscription",
    prepare: async () => ({
      statements: await recordStatements("get", (app) => getSubscription(app, U0, subLarge)),
    }),
  },
  listBenchmark("list.collection", "/subscription/:id for a collection, unread", async () =>
    appList({ subscriptionId: readingList })
  ),
  listBenchmark(
    "list.mostly_read_feed_unread",
    "unread only, 3,000-entry feed with 40 unread",
    async () => appList({ subscriptionId: subMostlyRead })
  ),
  listBenchmark(
    "list.keeps_up_unread",
    "/all, unread, a user with 60 unread of 30,000 entries",
    async () => appList({ userId: U_KEEPS_UP })
  ),
  {
    name: "wallabag.entries",
    kind: "read",
    source: "wallabag/entries.ts listWallabagEntries (perPage 30, detail full)",
    prepare: async () => ({ statements: await wallabagEntries({}) }),
  },
  {
    name: "search",
    kind: "read",
    source: "services/entries.ts searchEntries (all entries, two-word query)",
    prepare: async () => ({
      statements: await recordStatements("search", (app) =>
        listEntries(app, appList({ unreadOnly: false, query: searchQuery() }))
      ),
    }),
  },
  {
    name: "sync.events",
    kind: "read",
    source: "services/sync.ts sync.events: collectSyncEvents (~200 changes)",
    prepare: async (db) => {
      const cursors = await syncCursors(db, 200);
      return {
        statements: await recordStatements("sync", (app) => collectSyncEvents(app, U0, cursors)),
      };
    },
  },
  {
    name: "sync.changes",
    kind: "read",
    source: "services/sync.ts collectSyncChanges (sync.changes, ~200 changes)",
    prepare: async (db) => {
      const cursors = await syncCursors(db, 200);
      const deletions = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      return {
        statements: await recordStatements("sync", (app) =>
          collectSyncChanges(app, U0, {
            ...cursors,
            // The app sends the first page's cursor as `entriesSince` on every page.
            entriesSince: cursors.entries,
            entriesSinceAfterId: cursors.entriesAfterId,
            deletions,
          })
        ),
      };
    },
  },
  {
    name: "sync.events_catchup",
    kind: "read",
    source:
      "services/sync.ts sync.events: collectSyncEvents, first page of a ~5000-change catch-up",
    prepare: async (db) => {
      const cursors = await syncCursors(db, 5000);
      return {
        statements: await recordStatements("sync", (app) => collectSyncEvents(app, U0, cursors)),
      };
    },
  },
  {
    name: "wallabag.entries_since",
    kind: "read",
    source: "wallabag/entries.ts listWallabagEntries (since a week ago, perPage 30, detail full)",
    prepare: async () => ({
      statements: await wallabagEntries({
        since: String(Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60),
      }),
    }),
  },
  {
    name: "greader.stream_feed",
    kind: "read",
    source:
      "greader stream/contents route: resolveStreamListParams + listGreaderItemRefs + getEntries (feed/{n}, n=20)",
    prepare: async (db) => {
      const { stream } = await one<{ stream: string }>(
        db,
        `SELECT greader_stream_id::text AS stream FROM subscriptions WHERE id = ${q(subA)}`
      );
      return {
        statements: await greaderStream(`feed/${stream}`, {}, STREAM_CONTENTS_PAGE, true),
      };
    },
  },
  {
    name: "greader.stream_saved",
    kind: "read",
    source:
      "greader stream/contents route: resolveStreamListParams + listGreaderItemRefs + getEntries (Saved, n=20)",
    prepare: async (db) => {
      const { stream } = await one<{ stream: string }>(
        db,
        `SELECT greader_stream_id::text AS stream FROM subscriptions WHERE id = ${q(savedSubscriptionId(0))}`
      );
      return {
        statements: await greaderStream(`feed/${stream}`, {}, STREAM_CONTENTS_PAGE, true),
      };
    },
  },
  {
    name: "greader.items_ids",
    kind: "read",
    source:
      "greader stream/items/ids route: resolveStreamListParams + listGreaderItemRefs (unread reading list, n=10000)",
    prepare: async () => ({
      statements: await greaderStream(
        "user/-/state/com.google/reading-list",
        { xt: "user/-/state/com.google/read", n: "10000" },
        STREAM_ITEM_IDS_PAGE,
        false
      ),
    }),
  },
  {
    name: "greader.unread_count",
    kind: "read",
    source: "google-reader/subscriptions.ts getGreaderUnreadCounts",
    prepare: async () => ({
      statements: await recordStatements("counts", (app) => getGreaderUnreadCounts(app, U0)),
    }),
  },
];

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** A web feed's row, as the app reads it. */
async function feedRow(idx: number): Promise<Feed> {
  const [feed] = await appDb
    .select()
    .from(feeds)
    .where(eq(feeds.id, webFeedId(idx)));
  return feed;
}

/** A new article on the popular feed, as its feed lists it. */
function newFeedItem(seed: number, guid: string): ParsedEntry {
  const article = articleHtml(seed, 3);
  return {
    guid,
    link: guid,
    title: article.title,
    author: "Author 1",
    content: `<article>${article.html}</article>`,
  };
}

/**
 * `processEntries` (feed/entry-processor.ts) for one poll of the popular feed
 * whose document lists `fresh` new items followed by `kept` of its current
 * entries, unchanged.
 */
async function fetchStatements(db: ClientBase, fresh: number, kept: number): Promise<Statement[]> {
  const feed = await feedRow(WEB.popular);
  const current = await rows<Parameters<typeof feedItem>[0]>(
    db,
    `SELECT ${FEED_ITEM_COLUMNS} FROM entries
WHERE owner_feed_id = ${q(feed.id)}
  AND last_seen_at >= (SELECT last_entries_updated_at FROM feeds WHERE id = ${q(feed.id)})
ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC LIMIT ${kept}`
  );
  const items = [
    ...Array.from({ length: fresh }, (_, i) =>
      newFeedItem(1000 + i, `https://feed-${WEB.popular}.example.com/p/new-${i}`)
    ),
    ...current.map(feedItem),
  ];
  return recordStatements("fetch", async (app) => {
    const result = await processEntries(
      app,
      feed.id,
      { items },
      {
        fetchedAt: new Date(),
        previousLastEntriesUpdatedAt: feed.lastEntriesUpdatedAt,
        previousLastFetchedAt: feed.lastFetchedAt,
        feedUrl: feed.url ?? undefined,
        feedTitle: feed.title,
      }
    );
    if (result.newCount !== fresh || result.unchangedCount !== kept) {
      throw new Error(
        `expected ${fresh} new and ${kept} unchanged entries, got ${result.newCount} new, ` +
          `${result.updatedCount} updated and ${result.unchangedCount} unchanged`
      );
    }
  });
}

const WRITES: Benchmark[] = [
  {
    name: "write.update_entry_content",
    kind: "write",
    source: "feed/entry-processor.ts updateEntryContent (popular feed, ~20 holders)",
    prepare: async (db) => {
      const entry = await one<{ id: string; guid: string }>(
        db,
        `SELECT e.id, e.guid FROM entries e WHERE e.owner_feed_id = ${q(webFeedId(WEB.popular))}
ORDER BY COALESCE(e.published_at, e.fetched_at) DESC, e.id DESC LIMIT 1`
      );
      const item = newFeedItem(4242, entry.guid);
      return {
        statements: await recordStatements("update", (app) =>
          updateEntryContent(
            app,
            entry.id,
            item,
            generateContentHash(item),
            webFeedUrl(WEB.popular)
          )
        ),
      };
    },
  },
  {
    name: "write.fanout_one",
    kind: "write",
    source: "feed/entry-processor.ts processEntries (1 new of 50, 20 subscribers)",
    prepare: async (db) => ({ statements: await fetchStatements(db, 1, 49) }),
  },
  {
    name: "write.fanout_100",
    kind: "write",
    source: "feed/entry-processor.ts processEntries (100 new, 20 subscribers)",
    prepare: async (db) => ({ statements: await fetchStatements(db, 100, 0) }),
  },
  {
    name: "write.mark_read_one",
    kind: "write",
    source: "services/entry-state.ts markEntriesRead (one entry, tagged feed)",
    prepare: async (db) => {
      const { id } = await plainUnreadEntry(db);
      return {
        statements: await recordStatements("mark", (app) =>
          markEntriesRead(app, U0, [{ id }], true)
        ),
      };
    },
  },
  {
    name: "write.mark_all_read_feed",
    kind: "write",
    source: "services/entry-state.ts markAllEntriesRead (subscription with 4,000 unread)",
    prepare: async () => ({
      statements: await recordStatements("mark", (app) =>
        markAllEntriesRead(app, { userId: U0, subscriptionId: subA, showSpam: false })
      ),
    }),
  },
  {
    name: "write.star_one",
    kind: "write",
    source: "services/entry-state.ts updateEntriesStarred (one entry)",
    prepare: async (db) => {
      const { id } = await plainUnreadEntry(db);
      return {
        statements: await recordStatements("star", (app) =>
          updateEntriesStarred(app, U0, [{ id }], true)
        ),
      };
    },
  },
  {
    name: "write.set_scores_100",
    kind: "write",
    source: "services/entry-scores.ts setEntryScores (100 entries)",
    prepare: async (db) => {
      const ids = await newestVisibleIds(db, 100);
      return {
        statements: await recordStatements("scores", (app) =>
          setEntryScores(
            app,
            U0,
            ids.map((entryId, i) => ({ entryId, score: i }))
          )
        ),
      };
    },
  },
  {
    name: "write.subscribe_with_history",
    kind: "write",
    source: "services/subscribe.ts createSubscription (500 current entries)",
    prepare: async () => ({
      statements: await recordStatements("subscribe", (app) =>
        createSubscription(app, U0, { url: webFeedUrl(WEB.history) })
      ),
    }),
  },
  {
    name: "write.unsubscribe_large",
    kind: "write",
    source: "services/subscription-updates.ts unsubscribe (8,000-entry tagged feed)",
    prepare: async () => ({
      statements: await recordStatements("unsubscribe", (app) => unsubscribe(app, U0, subLarge)),
    }),
  },
  {
    name: "write.collection_add_1000",
    kind: "write",
    source:
      "services/collections.ts addEntriesToCollection (1,000 articles into an empty collection)",
    prepare: async (db) => {
      const ids = await newestVisibleIds(db, 1000);
      return {
        statements: await recordStatements("add", (app) =>
          addEntriesToCollection(app, U0, emptyCollection, ids)
        ),
      };
    },
  },
  {
    name: "write.collection_delete",
    kind: "write",
    source: "services/subscription-updates.ts unsubscribe on a collection (40 members)",
    prepare: async () => ({
      statements: await recordStatements("unsubscribe", (app) => unsubscribe(app, U0, readingList)),
    }),
  },
  {
    name: "write.collection_delete_1000",
    kind: "write",
    source: "services/subscription-updates.ts unsubscribe on a collection (1,000 members)",
    prepare: async () => ({
      statements: await recordStatements("unsubscribe", (app) =>
        unsubscribe(app, userId(1), archive)
      ),
    }),
  },
  {
    name: "write.save_article",
    kind: "write",
    source: "services/saved.ts saveArticle (a new URL, with the page's HTML)",
    prepare: async () => {
      const article = articleHtml(77, 12);
      return {
        statements: await recordStatements("save", (app) =>
          saveArticle(app, U0, {
            url: "https://news.example.org/2026/10/05/a-new-article",
            html: `<html><head><title>${article.title}</title></head><body><article>${article.html}</article></body></html>`,
          })
        ),
      };
    },
  },
  {
    name: "write.receive_email",
    kind: "write",
    source:
      "email/process-inbound.ts processInboundEmail: a new email from a sender U0 already has",
    prepare: async (db) => {
      const owner = await one<{ sender: string; title: string }>(
        db,
        `SELECT s.email_sender AS sender, COALESCE(s.custom_title, s.email_sender) AS title
FROM subscriptions s
WHERE s.user_id = ${q(U0)} AND s.type = 'email' ORDER BY s.email_sender LIMIT 1`
      );
      const article = articleHtml(91, 6);
      return {
        statements: await recordStatements("email", async (app) => {
          const result = await processInboundEmail(app, {
            to: `${U0_INGEST_TOKEN}@ingest.example.com`,
            from: { address: owner.sender, name: owner.title },
            subject: article.title,
            messageId: "<bench-email@example.net>",
            html: `<html><body>${article.html}</body></html>`,
            headers: { listUnsubscribe: "<mailto:unsubscribe@example.net>" },
            spamScore: 1.5,
            isSpam: false,
          });
          if (!result.success) throw new Error(`email rejected: ${result.error}`);
        }),
      };
    },
  },
  {
    name: "write.redirect_merge",
    kind: "write",
    source:
      "services/subscribe.ts mergeSubscriptionIntoFeed (1,500-entry feed onto a fresh 300-entry feed)",
    prepare: async () => {
      const target = await feedRow(WEB.mergeTarget);
      return {
        statements: await recordStatements("merge", async (app) => {
          if (!(await mergeSubscriptionIntoFeed(app, U0, subMergeSource, target))) {
            throw new Error("merge source isn't an active subscription");
          }
        }),
      };
    },
  },
  {
    name: "write.delete_saved_article",
    kind: "write",
    source:
      "services/saved.ts deleteSavedArticle (U0's oldest saved article; cascades to user_entries and its memberships)",
    prepare: async (db) => {
      const { id } = await one<{ id: string }>(
        db,
        `SELECT id FROM entries WHERE owner_user_id = ${q(U0)} ORDER BY id LIMIT 1`
      );
      return {
        statements: await recordStatements("delete", (app) => deleteSavedArticle(app, U0, id)),
      };
    },
  },
  {
    // No function deletes one feed: this is the cascade itself, hand-written.
    name: "write.delete_feed",
    kind: "write",
    source:
      "the cascade of deleting a feed, as services/users.ts deleteUser does an orphaned one (U0's 1,500-entry feed: its entries, user_entries, subscription and memberships)",
    prepare: async () => ({
      statements: [
        {
          label: "delete_feed",
          sql: `DELETE FROM feeds WHERE feeds.id = ${q(webFeedId(WEB.mergeSource))}`,
        },
      ],
    }),
  },
];

export const BENCHMARKS: Benchmark[] = [...READS, ...WRITES];
