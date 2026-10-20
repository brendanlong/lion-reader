/**
 * The database benchmarks: the SQL a service function sends for one user
 * action, against the seeded dataset (`seed.ts`). Reads record it by running
 * the function (`recordStatements`). Writes reproduce it statement by
 * statement and cite the function they mirror; **when that function's SQL
 * changes, change the benchmark with it**. Their values are inlined as
 * literals where the app binds parameters; the planner sees the same values
 * either way. Writes run inside a transaction that is rolled back (`run.ts`),
 * so every iteration starts from the same data.
 */

import type { ClientBase } from "pg";

import { db as appDb } from "@/server/db";
import {
  countUserLists,
  listEntries,
  listGreaderItemRefs,
  type ListEntriesParams,
} from "@/server/services/entries";
import { getEntries, getFullEntry } from "@/server/services/entry-reads";
import { collectSyncChanges, collectSyncEvents, currentSyncCursors } from "@/server/services/sync";
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
  U0,
  SPARSE_TAG,
  U_KEEPS_UP,
  WEB,
  benchUuid,
  collectionSubscriptionId,
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
  /** Bind parameters, for SQL recorded from the app (`recordStatements`). */
  params?: unknown[];
}

export interface PreparedBenchmark {
  /** Run inside the write transaction before the measured statements, unmeasured. */
  setup?: string[];
  statements: Statement[];
}

export interface Benchmark {
  name: string;
  kind: "read" | "write";
  /** The service function(s) whose SQL this records (reads) or reproduces (writes). */
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

const list = (values: string[]): string => values.map(q).join(", ");
const uuidArray = (ids: string[]): string => `'{${ids.join(",")}}'::uuid[]`;
const ts = (iso: string): string => `${q(iso)}::timestamptz`;
const nowIso = (): string => new Date().toISOString();

async function rows<T>(db: ClientBase, sql: string): Promise<T[]> {
  return (await db.query<T & Record<string, unknown>>(sql)).rows;
}

async function one<T>(db: ClientBase, sql: string): Promise<T> {
  const [row] = await rows<T>(db, sql);
  if (!row) throw new Error(`benchmark setup query returned no rows:\n${sql}`);
  return row;
}

/** `isCollectionSubscription()` (services/subscriptions.ts) over the unaliased `subscriptions`. */
const IS_COLLECTION = "subscriptions.type = 'collection'";

/** `buildEntriesInSubscriptionsCondition` (services/entry-filters.ts). */
function entriesInSubscriptions(
  ids: string[],
  columns: { userId: string; entryId: string }
): string {
  return `EXISTS (SELECT 1 FROM subscription_entries
  WHERE subscription_entries.user_id = ${columns.userId} AND subscription_entries.entry_id = ${columns.entryId}
    AND subscription_entries.subscription_id IN (${list(ids)}))`;
}

const UE_COLUMNS = { userId: "user_entries.user_id", entryId: "user_entries.entry_id" };

/**
 * `entryMemberships` joined with `entryOriginOn` (services/entry-filters.ts)
 * for a row's user and entry columns: the origin is `subscriptions`, and
 * `entry_memberships.subscription_ids` the active memberships.
 */
const membershipJoins = (userCol: string, entryCol: string): string =>
  `LEFT JOIN LATERAL (
  SELECT (array_agg(membership.subscription_id
      ORDER BY membership_subscription.unsubscribed_at IS NULL DESC, membership.subscription_id DESC)
      FILTER (WHERE membership_subscription.type <> 'collection'))[1] AS origin_id,
    COALESCE(array_agg(membership.subscription_id::text ORDER BY membership.subscription_id)
      FILTER (WHERE membership_subscription.unsubscribed_at IS NULL), '{}') AS subscription_ids
  FROM subscription_entries membership
  INNER JOIN subscriptions membership_subscription ON membership_subscription.id = membership.subscription_id
  WHERE membership.user_id = ${userCol} AND membership.entry_id = ${entryCol}
) entry_memberships ON true
LEFT JOIN subscriptions ON subscriptions.id = entry_memberships.origin_id AND subscriptions.user_id = ${userCol}`;

/** `verifySubscriptionOwnership` (services/entry-filters.ts). */
function verifyOwnershipSql(userId: string, subscriptionId: string): Statement {
  return {
    label: "verify_ownership",
    sql: `SELECT subscriptions.id FROM subscriptions
WHERE subscriptions.id = ${q(subscriptionId)} AND subscriptions.user_id = ${q(userId)}
  AND subscriptions.unsubscribed_at IS NULL
LIMIT 1`,
  };
}

/** `getUserUnreadCounts` (services/counts.ts). */
const userCountsSql = (userId: string): Statement => ({
  label: "counts.users",
  sql: `SELECT all_unread_count, starred_unread_count,
  COALESCE((SELECT s.unread_count FROM subscriptions s WHERE s.user_id = users.id AND s.type = 'saved'), 0),
  uncategorized_unread_count
FROM users WHERE users.id = ${q(userId)}`,
});

/**
 * `getBulkEntryRelatedCounts` (services/counts.ts). Its later lookups depend
 * on the earlier ones' results, so those run here first (against the
 * pre-write state, which is what they read for every benchmark using this).
 */
async function bulkCounts(
  db: ClientBase,
  userId: string,
  entries: Array<{ id?: string; subscriptionId: string | null }>
): Promise<Statement[]> {
  const out: Statement[] = [];
  const entryIds = entries.flatMap((e) => (e.id ? [e.id] : []));
  let memberOf: string[] = [];
  if (entryIds.length > 0) {
    const sql = `SELECT DISTINCT subscription_entries.subscription_id FROM subscription_entries
INNER JOIN subscriptions ON subscriptions.id = subscription_entries.subscription_id
WHERE subscription_entries.user_id = ${q(userId)} AND subscriptions.unsubscribed_at IS NULL
  AND subscriptions.type <> 'saved' AND subscription_entries.entry_id = ANY(${uuidArray(entryIds)})`;
    memberOf = (await rows<{ subscription_id: string }>(db, sql)).map((r) => r.subscription_id);
    out.push({ label: "counts.memberships", sql });
  }
  const subscriptionIds = [
    ...new Set([
      ...entries.flatMap((e) => (!e.id && e.subscriptionId ? [e.subscriptionId] : [])),
      ...memberOf,
    ]),
  ];
  out.push(userCountsSql(userId));
  if (subscriptionIds.length === 0) return out;
  out.push({
    label: "counts.subscriptions",
    sql: `SELECT subscriptions.id, subscriptions.unread_count FROM subscriptions
WHERE subscriptions.user_id = ${q(userId)} AND subscriptions.id IN (${list(subscriptionIds)})`,
  });
  const subTagsSql = `SELECT subscription_tags.subscription_id, subscription_tags.tag_id FROM subscription_tags
WHERE subscription_tags.subscription_id IN (${list(subscriptionIds)})`;
  out.push({ label: "counts.subscription_tags", sql: subTagsSql });
  const tagIds = [
    ...new Set((await rows<{ tag_id: string }>(db, subTagsSql)).map((r) => r.tag_id)),
  ];
  if (tagIds.length > 0) out.push(tagCountsSql(userId, tagIds));
  return out;
}

/** `getTagUnreadCounts` (services/counts.ts). */
const tagCountsSql = (userId: string, tagIds: string[]): Statement => ({
  label: "counts.tags",
  sql: `SELECT tags.id, tags.unread_count FROM tags
WHERE tags.user_id = ${q(userId)} AND tags.id IN (${list(tagIds)})`,
});

/** `ensureFeedJob` (jobs/queue.ts). */
const ensureFeedJobSql = (feedId: string): Statement => ({
  label: "ensure_feed_job",
  sql: `INSERT INTO jobs (id, type, payload, next_run_at, created_at, updated_at)
VALUES (${q(benchUuid(`job:${feedId}:new`))}, 'fetch_feed', ${q(JSON.stringify({ feedId }))}::jsonb, now(), now(), now())
ON CONFLICT ((payload->>'feedId')) WHERE type = 'fetch_feed'
DO UPDATE SET next_run_at = COALESCE(jobs.next_run_at, now()), updated_at = now()
RETURNING *`,
});

/** `insertUserEntriesWithMemberships` (services/subscription-entries.ts) for `candidates`. */
const insertWithMembershipsSql = (label: string, candidates: string): Statement => ({
  label,
  sql: `WITH c AS (${candidates}),
missing AS (
  SELECT c.subscription_id, c.user_id, c.entry_id, c.is_spam, c.read,
         COALESCE(ue.read, c.read) AS state_read, COALESCE(ue.starred, false) AS state_starred,
         COALESCE(ue.is_spam, c.is_spam) AS state_is_spam,
         (s.unsubscribed_at IS NULL)::int AS active_memberships,
         COALESCE(ue.published_or_fetched_at, c.published_or_fetched_at) AS published_or_fetched_at
  FROM c
  JOIN subscriptions s ON s.id = c.subscription_id
  LEFT JOIN user_entries ue ON ue.user_id = c.user_id AND ue.entry_id = c.entry_id
  WHERE NOT EXISTS (
    SELECT 1 FROM subscription_entries se
    WHERE se.subscription_id = c.subscription_id AND se.entry_id = c.entry_id
  )
),
new_rows AS (
  INSERT INTO user_entries (user_id, entry_id, published_or_fetched_at, is_spam, read, active_memberships)
  SELECT user_id, entry_id, published_or_fetched_at, is_spam, read, active_memberships FROM missing
  ON CONFLICT DO NOTHING
)
INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at,
                                  read, starred, is_spam)
SELECT subscription_id, user_id, entry_id, published_or_fetched_at,
       state_read, state_starred, state_is_spam
FROM missing
ON CONFLICT DO NOTHING
RETURNING subscription_id, entry_id`,
});

/** `holdsRedirectTwin` (services/subscription-entries.ts). */
const holdsRedirectTwinSql = (subscriptionId: string, entry: string): string => `EXISTS (
    SELECT 1
    FROM entries e_prev
    JOIN subscription_entries se_prev
      ON se_prev.subscription_id = ${subscriptionId} AND se_prev.entry_id = e_prev.id
    WHERE e_prev.type = 'web'
      AND regexp_replace(e_prev.guid, '^https?://', 'https://') = regexp_replace(${entry}.guid, '^https?://', 'https://')
      AND e_prev.owner_feed_id <> ${entry}.owner_feed_id
  )`;

/** `populateInitialUserEntries` (services/subscribe.ts). */
const populateSql = (userId: string, subscriptionId: string, feedId: string): Statement =>
  insertWithMembershipsSql(
    "populate",
    `SELECT ${q(subscriptionId)}::uuid AS subscription_id, ${q(userId)}::uuid AS user_id, e.id AS entry_id,
       COALESCE(e.published_at, e.fetched_at) AS published_or_fetched_at,
       e.is_spam, false AS read
FROM entries e
JOIN feeds f ON f.id = e.owner_feed_id
WHERE e.owner_feed_id = ${q(feedId)}
  AND e.type = 'web'
  AND f.last_entries_updated_at IS NOT NULL
  AND e.last_seen_at >= f.last_entries_updated_at
  AND NOT ${holdsRedirectTwinSql(`${q(subscriptionId)}::uuid`, "e")}`
  );

/** `lockSubscriptionMembers` (services/subscriptions.ts) for the subscriptions matching `where`. */
const lockMembersSql = (userId: string, where: string): Statement => ({
  label: "lock_members",
  sql: `SELECT user_entries.entry_id FROM user_entries
INNER JOIN subscription_entries ON subscription_entries.user_id = user_entries.user_id
  AND subscription_entries.entry_id = user_entries.entry_id
INNER JOIN subscriptions ON subscriptions.id = subscription_entries.subscription_id
WHERE user_entries.user_id = ${q(userId)} AND subscriptions.user_id = ${q(userId)} AND ${where}
ORDER BY user_entries.entry_id
FOR NO KEY UPDATE OF user_entries`,
});

/** `unsubscribe` (services/subscription-updates.ts), from its existence check to its counts. */
async function unsubscribeStatements(
  db: ClientBase,
  userId: string,
  subscriptionId: string
): Promise<Statement[]> {
  const sub = `subscriptions.id = ${q(subscriptionId)} AND subscriptions.user_id = ${q(userId)}`;
  const now = ts(nowIso());
  const { type } = await one<{ type: string }>(
    db,
    `SELECT type FROM subscriptions WHERE id = ${q(subscriptionId)}`
  );
  const formerTags = (
    await rows<{ tag_id: string }>(
      db,
      `SELECT tag_id FROM subscription_tags WHERE subscription_id = ${q(subscriptionId)}`
    )
  ).map((r) => r.tag_id);
  return [
    {
      label: "existing",
      sql: `SELECT feeds.* FROM subscriptions LEFT JOIN feeds ON subscriptions.feed_id = feeds.id
WHERE ${sub} AND subscriptions.unsubscribed_at IS NULL LIMIT 1`,
    },
    // lockSubscriptionRow(..., { members: true })
    lockMembersSql(userId, `subscriptions.id = ${q(subscriptionId)}`),
    {
      label: "lock_subscription",
      sql: `SELECT subscriptions.id FROM subscriptions WHERE ${sub} FOR UPDATE`,
    },
    {
      label: "soft_delete",
      sql: `UPDATE subscriptions SET unsubscribed_at = ${now}, updated_at = ${now}
WHERE ${sub} AND subscriptions.unsubscribed_at IS NULL
RETURNING subscriptions.id, subscriptions.type`,
    },
    ...(type === "collection"
      ? [
          {
            label: "touch_members",
            sql: `UPDATE user_entries SET updated_at = ${now}
WHERE user_entries.user_id = ${q(userId)} AND user_entries.entry_id IN (
  SELECT subscription_entries.entry_id FROM subscription_entries
  WHERE subscription_entries.subscription_id = ${q(subscriptionId)})`,
          },
        ]
      : []),
    {
      label: "delete_tags",
      sql: `DELETE FROM subscription_tags
WHERE subscription_tags.subscription_id IN (SELECT subscriptions.id FROM subscriptions WHERE ${sub})
RETURNING subscription_tags.tag_id`,
    },
    // getBulkEntryRelatedCounts with the former tags
    userCountsSql(userId),
    ...(formerTags.length > 0 ? [tagCountsSql(userId, formerTags)] : []),
  ];
}

/** Statements adding articles to a collection: `addEntriesToCollection` (services/collections.ts). */
function addToCollectionStatements(
  userId: string,
  collection: string,
  entryIds: string[]
): Statement[] {
  const ids = list(entryIds);
  return [
    // lockUserEntryRows
    {
      label: "lock_entries",
      sql: `SELECT user_entries.entry_id FROM user_entries
WHERE user_entries.user_id = ${q(userId)} AND user_entries.entry_id IN (${ids})
ORDER BY user_entries.entry_id FOR NO KEY UPDATE`,
    },
    // assertOwnedCollections(..., { lock: true })
    {
      label: "lock_collection",
      sql: `SELECT subscriptions.id FROM subscriptions
WHERE subscriptions.id IN (${q(collection)}) AND subscriptions.user_id = ${q(userId)}
  AND subscriptions.unsubscribed_at IS NULL AND ${IS_COLLECTION}
FOR NO KEY UPDATE OF subscriptions`,
    },
    {
      label: "count",
      sql: `SELECT count(*)::int FROM subscription_entries WHERE subscription_entries.subscription_id = ${q(collection)}`,
    },
    {
      label: "insert",
      sql: `INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at,
                                  read, starred, is_spam)
SELECT ${q(collection)}::uuid AS subscription_id, ve.user_id, ve.id, ve.published_or_fetched_at,
       ve.read, ve.starred, ve.is_spam
FROM visible_entries ve
WHERE ve.user_id = ${q(userId)} AND ve.id IN (${ids})
ON CONFLICT DO NOTHING
RETURNING subscription_entries.entry_id`,
    },
    // touchUserEntries
    {
      label: "touch",
      sql: `UPDATE user_entries SET updated_at = ${ts(nowIso())}
WHERE user_entries.user_id = ${q(userId)} AND user_entries.entry_id IN (${ids})`,
    },
  ];
}

/** HTML for a new article: `paragraphs` paragraphs of made-up words. */
function articleHtml(
  seed: number,
  paragraphs: number
): { title: string; html: string; summary: string } {
  const rand = prng(seed);
  const vocab = vocabulary();
  const word = () => vocab[Math.floor(5000 * rand() ** 3)];
  const paragraph = () => Array.from({ length: 40 + Math.floor(rand() * 100) }, word).join(" ");
  const paras = Array.from({ length: paragraphs }, paragraph);
  return {
    title: Array.from({ length: 6 }, word).join(" "),
    html: paras.map((p) => `<p>${p}.</p>`).join("\n"),
    summary: paras[0].slice(0, 280),
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
  listBenchmark("list.score_tag", "/tag/:id, by score", async () =>
    appList({ tagId: tagId(0, 1), sortBy: "score" })
  ),
  listBenchmark(
    "list.collection_position",
    "/subscription/:id for a collection, by position",
    async () => appList({ subscriptionId: readingList, sortBy: "position" })
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
    name: "wallabag.entries_archived",
    kind: "read",
    source: "wallabag/entries.ts listWallabagEntries (sort archived, perPage 30, detail full)",
    prepare: async () => ({ statements: await wallabagEntries({ sort: "archived" }) }),
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

/**
 * `processEntries` (feed/entry-processor.ts) for one fetch of the popular feed
 * whose document holds `fresh` new items followed by `kept` of the feed's
 * current ones: the guid lookup, `createEntry` per new item, the disappeared
 * check, `updateEntriesLastSeenAt` and `createUserEntriesForFeed`; then the
 * feed row's update in `processSuccessfulFetch` (jobs/handlers/fetch-feed.ts).
 */
async function fetchStatements(db: ClientBase, fresh: number, kept: number): Promise<Statement[]> {
  const feedId = webFeedId(WEB.popular);
  const feed = await one<{ last_entries_updated_at: string; last_fetched_at: string }>(
    db,
    `SELECT last_entries_updated_at::text, last_fetched_at::text FROM feeds WHERE id = ${q(feedId)}`
  );
  const current = await rows<{ id: string; guid: string }>(
    db,
    `SELECT id, guid FROM entries WHERE owner_feed_id = ${q(feedId)} AND last_seen_at >= ${ts(feed.last_entries_updated_at)}
ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC LIMIT ${kept}`
  );
  const fetchedAt = nowIso();
  const created = Array.from({ length: fresh }, (_, i) => {
    const article = articleHtml(1000 + i, 3);
    const guid = `https://feed-${WEB.popular}.example.com/p/new-${i}`;
    return { id: benchUuid(`new-entry:${i}`), guid, ...article };
  });
  const guids = [...created.map((e) => e.guid), ...current.map((e) => e.guid)];
  const candidates = guids.flatMap((g) => {
    const rest = g.replace(/^https?:\/\//, "");
    return [`http://${rest}`, `https://${rest}`];
  });
  const allIds = [...created.map((e) => e.id), ...current.map((e) => e.id)];
  return [
    {
      label: "existing",
      sql: `SELECT entries.id, entries.guid, entries.content_hash FROM entries
WHERE entries.owner_feed_id = ${q(feedId)} AND entries.guid IN (${list(candidates)})`,
    },
    ...created.map((e, i) => ({
      label: `create_entry.${i}`,
      sql: `INSERT INTO entries (id, owner_feed_id, type, guid, url, title, author, content_original, content_cleaned,
  summary, content_hash, published_at, fetched_at, last_seen_at)
VALUES (${q(e.id)}, ${q(feedId)}, 'web', ${q(e.guid)}, ${q(e.guid)}, ${q(e.title)}, 'Author 1',
  ${q(`<article>${e.html}</article>`)}, ${q(e.html)}, ${q(e.summary)}, ${q(benchUuid(e.guid))},
  ${ts(fetchedAt)}, ${ts(fetchedAt)}, ${ts(fetchedAt)})
RETURNING *`,
    })),
    {
      label: "previously_current",
      sql: `SELECT entries.guid FROM entries
WHERE entries.owner_feed_id = ${q(feedId)} AND entries.type = 'web'
  AND entries.last_seen_at >= ${ts(feed.last_entries_updated_at)}`,
    },
    {
      label: "update_last_seen",
      sql: `UPDATE entries SET last_seen_at = ${ts(fetchedAt)}
WHERE entries.id IN (${list(allIds)})
  AND (entries.last_seen_at IS NULL OR entries.last_seen_at < ${ts(fetchedAt)})`,
    },
    insertWithMembershipsSql(
      "fanout",
      `WITH missing AS MATERIALIZED (
  SELECT s.id AS subscription_id, s.user_id, e.id AS entry_id,
         COALESCE(e.published_at, e.fetched_at) AS published_or_fetched_at,
         e.is_spam, COALESCE(e.published_at < ${ts(feed.last_fetched_at)} - interval '30 days'
           AND EXISTS (SELECT 1 FROM subscription_entries held WHERE held.subscription_id = s.id), false) AS read,
         e.guid, e.owner_feed_id
  FROM subscriptions s
  INNER JOIN entries e ON e.owner_feed_id = s.feed_id
  WHERE s.feed_id = ${q(feedId)}::uuid
    AND s.unsubscribed_at IS NULL
    AND e.id = ANY(${uuidArray(allIds)})
    AND NOT EXISTS (
      SELECT 1 FROM subscription_entries se
      WHERE se.subscription_id = s.id AND se.entry_id = e.id
    )
)
SELECT subscription_id, user_id, entry_id, published_or_fetched_at, is_spam, read
FROM missing m
WHERE NOT ${holdsRedirectTwinSql("m.subscription_id", "m")}`
    ),
    {
      label: "update_feed",
      sql: `UPDATE feeds SET title = feeds.title, description = feeds.description, site_url = feeds.site_url,
  etag = NULL, last_modified_header = NULL, body_hash = ${q(benchUuid(`body:${fetchedAt}`))},
  last_fetched_at = ${ts(fetchedAt)}, last_entries_updated_at = ${ts(fetchedAt)},
  next_fetch_at = ${ts(fetchedAt)}::timestamptz + interval '1 hour',
  ttl_minutes = NULL, syndication_update_period = NULL, syndication_update_frequency = NULL,
  consecutive_failures = 0, last_error = NULL, hub_url = NULL, self_url = feeds.self_url,
  last_fetch_entry_count = ${allIds.length}, last_fetch_size_bytes = 100000, updated_at = ${ts(fetchedAt)}
WHERE feeds.id = ${q(feedId)}`,
    },
  ];
}

/** `markEntriesRead` / `updateEntriesStarred` UPDATE (services/entry-state.ts). */
function flagUpdateSql(userId: string, entryId: string, column: "read" | "starred"): Statement {
  const now = ts(nowIso());
  const guard =
    column === "read"
      ? "(ue.read_changed_at IS NULL OR ue.read_changed_at <= v.ts)"
      : "ue.starred_changed_at <= v.ts";
  const set =
    column === "read"
      ? `read = true, updated_at = CASE WHEN prev.read <> true THEN ${now} ELSE ue.updated_at END, read_changed_at = v.ts`
      : `starred = true, starred_changed_at = v.ts, updated_at = CASE WHEN prev.starred <> true THEN ${now} ELSE ue.updated_at END`;
  return {
    label: "update",
    sql: `UPDATE user_entries AS ue
SET ${set}
FROM (VALUES (${q(entryId)}::uuid, ${now})) AS v(entry_id, ts)
JOIN user_entries AS prev ON prev.user_id = ${q(userId)}::uuid AND prev.entry_id = v.entry_id
WHERE ue.user_id = ${q(userId)}::uuid AND ue.entry_id = v.entry_id AND ${guard}
RETURNING ue.entry_id AS entry_id, prev.${column} AS old_${column}`,
  };
}

const WRITES: Benchmark[] = [
  {
    name: "write.update_entry_content",
    kind: "write",
    source: "feed/entry-processor.ts updateEntryContent (popular feed, ~20 holders)",
    prepare: async (db) => {
      const feedId = webFeedId(WEB.popular);
      const { id } = await one<{ id: string }>(
        db,
        `SELECT e.id FROM entries e WHERE e.owner_feed_id = ${q(feedId)}
ORDER BY COALESCE(e.published_at, e.fetched_at) DESC, e.id DESC LIMIT 1`
      );
      const article = articleHtml(4242, 3);
      return {
        statements: [
          {
            label: "update",
            sql: `UPDATE entries SET title = ${q(article.title)}, author = 'Author 1',
  content_original = ${q(`<article>${article.html}</article>`)}, content_cleaned = ${q(article.html)},
  summary = ${q(article.summary)}, content_hash = ${q(benchUuid("refetched"))}, updated_at = ${ts(nowIso())}
WHERE entries.id = ${q(id)}
RETURNING *`,
          },
        ],
      };
    },
  },
  {
    name: "write.fanout_one",
    kind: "write",
    source:
      "feed/entry-processor.ts processEntries + createUserEntriesForFeed (1 new of 50, 20 subscribers)",
    prepare: async (db) => ({ statements: await fetchStatements(db, 1, 49) }),
  },
  {
    name: "write.fanout_100",
    kind: "write",
    source:
      "feed/entry-processor.ts processEntries + createUserEntriesForFeed (100 new, 20 subscribers)",
    prepare: async (db) => ({ statements: await fetchStatements(db, 100, 0) }),
  },
  {
    name: "write.mark_read_one",
    kind: "write",
    source: "services/entry-state.ts markEntriesRead (one entry, tagged feed)",
    prepare: async (db) => {
      const entry = await plainUnreadEntry(db);
      return {
        statements: [
          flagUpdateSql(U0, entry.id, "read"),
          {
            label: "readback",
            sql: `SELECT ve.id, subscriptions.id, entry_memberships.subscription_ids, ve.read,
  ve.starred, ve.type, ve.updated_at, ve.read_changed_at
FROM visible_entries ve
${membershipJoins("ve.user_id", "ve.id")}
WHERE ve.user_id = ${q(U0)} AND ve.id IN (${q(entry.id)})`,
          },
          ...(await bulkCounts(db, U0, [{ id: entry.id, subscriptionId: entry.subscription_id }])),
        ],
      };
    },
  },
  {
    name: "write.mark_all_read_feed",
    kind: "write",
    source: "services/entry-state.ts markAllEntriesRead (subscription with 4,000 unread)",
    prepare: async (db) => {
      const filter = entriesInSubscriptions([subA], UE_COLUMNS);
      const changedAt = ts(nowIso());
      const marked = await rows<{ id: string; subscription_id: string }>(
        db,
        `SELECT ue.entry_id AS id, se.subscription_id FROM subscription_entries se
JOIN user_entries ue ON ue.user_id = se.user_id AND ue.entry_id = se.entry_id
WHERE se.subscription_id = ${q(subA)} AND NOT ue.read AND NOT ue.is_spam`
      );
      return {
        statements: [
          verifyOwnershipSql(U0, subA),
          {
            label: "update",
            sql: `UPDATE user_entries SET read = true, read_changed_at = ${changedAt}, updated_at = ${changedAt}
WHERE user_entries.user_id = ${q(U0)} AND user_entries.read = false
  AND (user_entries.read_changed_at IS NULL OR user_entries.read_changed_at <= ${changedAt})
  AND (user_entries.starred = true OR user_entries.active_memberships > 0)
  AND user_entries.is_spam = false
  AND ${filter}
RETURNING user_entries.entry_id`,
          },
          ...(await bulkCounts(
            db,
            U0,
            marked.map((m) => ({ id: m.id, subscriptionId: null }))
          )),
        ],
      };
    },
  },
  {
    name: "write.star_one",
    kind: "write",
    source: "services/entry-state.ts updateEntriesStarred (one entry)",
    prepare: async (db) => {
      const entry = await plainUnreadEntry(db);
      return {
        statements: [
          flagUpdateSql(U0, entry.id, "starred"),
          // selectStarredEntryStates
          {
            label: "readback",
            sql: `SELECT user_entries.entry_id, subscriptions.id,
  entry_memberships.subscription_ids, user_entries.read,
  user_entries.starred, entries.type, user_entries.changed_at,
  user_entries.read_changed_at
FROM user_entries INNER JOIN entries ON entries.id = user_entries.entry_id
${membershipJoins("user_entries.user_id", "user_entries.entry_id")}
WHERE user_entries.user_id = ${q(U0)} AND user_entries.entry_id IN (${q(entry.id)})`,
          },
          ...(await bulkCounts(db, U0, [{ id: entry.id, subscriptionId: entry.subscription_id }])),
        ],
      };
    },
  },
  {
    name: "write.set_scores_100",
    kind: "write",
    source: "services/entry-scores.ts setEntryScores (100 entries)",
    prepare: async (db) => {
      const ids = await newestVisibleIds(db, 100);
      const values = ids.map((id, i) => `(${q(id)}::uuid, ${i}::double precision)`).join(", ");
      const visible = "(user_entries.starred = true OR user_entries.active_memberships > 0)";
      return {
        statements: [
          {
            label: "visible",
            sql: `SELECT entry_id FROM user_entries
WHERE user_id = ${q(U0)} AND entry_id IN (${ids.map(q).join(", ")}) AND ${visible}`,
          },
          {
            label: "update",
            sql: `UPDATE user_entries SET score = v.score, updated_at = ${q(new Date().toISOString())}
FROM (VALUES ${values}) AS v(entry_id, score)
WHERE user_entries.user_id = ${q(U0)} AND user_entries.entry_id = v.entry_id AND ${visible}
  AND user_entries.score IS DISTINCT FROM v.score
RETURNING user_entries.entry_id, user_entries.score`,
          },
        ],
      };
    },
  },
  {
    name: "write.subscribe_with_history",
    kind: "write",
    source:
      "services/subscribe.ts createSubscription + populateInitialUserEntries (500 current entries)",
    prepare: async () => {
      const feedId = webFeedId(WEB.history);
      const url = webFeedUrl(WEB.history);
      const newSub = benchUuid("bench:new-subscription");
      const now = ts(nowIso());
      return {
        statements: [
          {
            label: "upsert_feed",
            sql: `INSERT INTO feeds (id, url, title, description, site_url, next_fetch_at, created_at, updated_at)
VALUES (${q(benchUuid("bench:new-feed"))}, ${q(url)}, NULL, NULL, NULL, ${now}, ${now}, ${now})
ON CONFLICT (url) DO NOTHING`,
          },
          { label: "select_feed", sql: `SELECT * FROM feeds WHERE feeds.url = ${q(url)} LIMIT 1` },
          ensureFeedJobSql(feedId),
          // lockAndCountActiveSubscriptions
          { label: "advisory_lock", sql: `SELECT pg_advisory_xact_lock(hashtext(${q(U0)}))` },
          {
            label: "count_active",
            sql: `SELECT count(*)::int FROM subscriptions
WHERE subscriptions.user_id = ${q(U0)} AND subscriptions.unsubscribed_at IS NULL`,
          },
          lockMembersSql(
            U0,
            `subscriptions.feed_id = ${q(feedId)} AND subscriptions.unsubscribed_at IS NOT NULL`
          ),
          {
            label: "upsert_subscription",
            sql: `INSERT INTO subscriptions (id, user_id, feed_id, type, subscribed_at, created_at, updated_at, fetch_full_content)
VALUES (${q(newSub)}, ${q(U0)}, ${q(feedId)}, 'web', ${now}, ${now}, ${now}, false)
ON CONFLICT (user_id, feed_id) DO UPDATE SET unsubscribed_at = NULL, subscribed_at = ${now}, updated_at = ${now}
WHERE subscriptions.unsubscribed_at IS NOT NULL
RETURNING id, subscribed_at, custom_title, fetch_full_content`,
          },
          populateSql(U0, newSub, feedId),
          userCountsSql(U0),
          {
            label: "counts.subscriptions",
            sql: `SELECT subscriptions.id, subscriptions.unread_count FROM subscriptions
WHERE subscriptions.user_id = ${q(U0)} AND subscriptions.id IN (${q(newSub)})`,
          },
          {
            label: "counts.subscription_tags",
            sql: `SELECT subscription_tags.subscription_id, subscription_tags.tag_id FROM subscription_tags
WHERE subscription_tags.subscription_id IN (${q(newSub)})`,
          },
        ],
      };
    },
  },
  {
    name: "write.unsubscribe_large",
    kind: "write",
    source: "services/subscription-updates.ts unsubscribe (8,000-entry tagged feed)",
    prepare: async (db) => ({ statements: await unsubscribeStatements(db, U0, subLarge) }),
  },
  {
    name: "write.collection_add_1000",
    kind: "write",
    source:
      "services/collections.ts addEntriesToCollection (1,000 articles into an empty collection)",
    prepare: async (db) => {
      const ids = await newestVisibleIds(db, 1000);
      return {
        statements: [
          ...addToCollectionStatements(U0, emptyCollection, ids),
          ...(await bulkCounts(db, U0, [{ subscriptionId: emptyCollection }])),
        ],
      };
    },
  },
  {
    name: "write.collection_delete",
    kind: "write",
    source: "services/subscription-updates.ts unsubscribe on a collection (40 members)",
    prepare: async (db) => ({ statements: await unsubscribeStatements(db, U0, readingList) }),
  },
  {
    name: "write.collection_delete_1000",
    kind: "write",
    source: "services/subscription-updates.ts unsubscribe on a collection (1,000 members)",
    prepare: async (db) => ({ statements: await unsubscribeStatements(db, userId(1), archive) }),
  },
  {
    name: "write.save_article",
    kind: "write",
    source: "services/saved.ts saveArticle: selectExistingSavedRow + insertSavedEntry",
    prepare: async () => {
      const url = "https://news.example.org/2026/10/05/a-new-article";
      const article = articleHtml(77, 12);
      const now = ts(nowIso());
      const entryId = benchUuid("bench:saved-entry");
      return {
        statements: [
          {
            label: "existing",
            sql: `SELECT entries.*, user_entries.* FROM entries
INNER JOIN user_entries ON user_entries.entry_id = entries.id
WHERE entries.owner_user_id = ${q(U0)} AND entries.guid = ${q(url)} AND user_entries.user_id = ${q(U0)}
LIMIT 1`,
          },
          {
            label: "insert_entry",
            sql: `INSERT INTO entries (id, owner_user_id, type, guid, url, title, author, content_original, content_cleaned,
  summary, site_name, image_url, is_placeholder, published_at, fetched_at, content_hash, spam_score, is_spam,
  list_unsubscribe_mailto, list_unsubscribe_https, list_unsubscribe_post, created_at, updated_at)
VALUES (${q(entryId)}, ${q(U0)}, 'saved', ${q(url)}, ${q(url)}, ${q(article.title)}, 'A. Writer',
  ${q(`<html><body><article>${article.html}</article></body></html>`)}, ${q(article.html)}, ${q(article.summary)},
  'news.example.org', 'https://news.example.org/lead.jpg', false, NULL, ${now}, ${q(benchUuid(url))}, NULL, false,
  NULL, NULL, NULL, ${now}, ${now})
ON CONFLICT DO NOTHING
RETURNING entries.id`,
          },
          {
            label: "ensure_saved_subscription",
            sql: `SELECT ensure_saved_subscriptions(ARRAY[${q(U0)}::uuid])`,
          },
          insertWithMembershipsSql(
            "insert_user_entry",
            `SELECT s.id AS subscription_id, s.user_id, e.id AS entry_id,
       COALESCE(e.published_at, e.fetched_at) AS published_or_fetched_at,
       e.is_spam, false AS read
FROM subscriptions s
JOIN entries e ON e.id = ${q(entryId)}
WHERE s.user_id = ${q(U0)} AND s.type = 'saved'`
          ),
        ],
      };
    },
  },
  {
    name: "write.receive_email",
    kind: "write",
    source:
      "email/process-inbound.ts processInboundEmail: a new email from a sender U0 already has (steps 5–7)",
    prepare: async (db) => {
      const owner = await one<{ id: string; sender: string; title: string }>(
        db,
        `SELECT s.id, s.email_sender AS sender, COALESCE(s.custom_title, s.email_sender) AS title
FROM subscriptions s
WHERE s.user_id = ${q(U0)} AND s.type = 'email' ORDER BY s.email_sender LIMIT 1`
      );
      const article = articleHtml(91, 6);
      const now = ts(nowIso());
      const entryId = benchUuid("bench:email-entry");
      const messageId = "<bench-email@example.net>";
      const isSender = `subscriptions.user_id = ${q(U0)} AND subscriptions.type = 'email'
  AND subscriptions.email_sender = ${q(owner.sender)}`;
      return {
        statements: [
          {
            label: "lock_members",
            sql: `SELECT user_entries.entry_id FROM user_entries
INNER JOIN subscription_entries ON subscription_entries.user_id = user_entries.user_id
  AND subscription_entries.entry_id = user_entries.entry_id
INNER JOIN subscriptions ON subscriptions.id = subscription_entries.subscription_id
WHERE user_entries.user_id = ${q(U0)} AND ${isSender} AND subscriptions.unsubscribed_at IS NOT NULL
ORDER BY user_entries.entry_id FOR NO KEY UPDATE OF user_entries`,
          },
          {
            label: "upsert_subscription",
            sql: `INSERT INTO subscriptions (id, user_id, type, email_sender, custom_title, subscribed_at, created_at, updated_at)
VALUES (${q(benchUuid("bench:email-subscription"))}, ${q(U0)}, 'email', ${q(owner.sender)}, ${q(owner.title)},
  ${now}, ${now}, ${now})
ON CONFLICT (user_id, email_sender) WHERE subscriptions.type = 'email'
  DO UPDATE SET unsubscribed_at = NULL, updated_at = ${now} WHERE subscriptions.unsubscribed_at IS NOT NULL
RETURNING *`,
          },
          {
            label: "owner_subscription",
            sql: `SELECT subscriptions.id, COALESCE(subscriptions.custom_title, subscriptions.email_sender)
FROM subscriptions WHERE ${isSender}`,
          },
          {
            label: "duplicate",
            sql: `SELECT entries.id FROM entries
WHERE entries.owner_subscription_id = ${q(owner.id)} AND entries.guid = ${q(messageId)} LIMIT 1`,
          },
          {
            label: "insert_entry",
            sql: `INSERT INTO entries (id, owner_subscription_id, type, guid, url, title, author, content_original,
  content_cleaned, summary, published_at, fetched_at, content_hash, spam_score, is_spam, list_unsubscribe_mailto,
  list_unsubscribe_https, list_unsubscribe_post, unsubscribe_url)
VALUES (${q(entryId)}, ${q(owner.id)}, 'email', ${q(messageId)}, NULL,
  ${q(article.title)}, ${q(owner.title)}, ${q(`<html><body>${article.html}</body></html>`)}, ${q(article.html)},
  ${q(article.summary)}, ${now}, ${now}, ${q(benchUuid(messageId))}, 1.5, false, 'mailto:unsubscribe@example.net',
  NULL, false, NULL)`,
          },
          insertWithMembershipsSql(
            "insert_user_entry",
            `SELECT ${q(owner.id)}::uuid AS subscription_id, ${q(U0)}::uuid AS user_id, e.id AS entry_id,
       COALESCE(e.published_at, e.fetched_at) AS published_or_fetched_at,
       e.is_spam, false AS read
FROM entries e
WHERE e.id = ${q(entryId)}`
          ),
        ],
      };
    },
  },
  {
    name: "write.redirect_merge",
    kind: "write",
    source:
      "services/subscribe.ts mergeSubscriptionIntoFeed (1,500-entry feed onto a fresh 300-entry feed)",
    prepare: async (db) => {
      const newFeed = webFeedId(WEB.mergeTarget);
      const survivor = benchUuid("bench:merge-survivor");
      const old = await one<{ custom_title: string | null }>(
        db,
        `SELECT custom_title FROM subscriptions WHERE id = ${q(subMergeSource)}`
      );
      const movedTags = (
        await rows<{ tag_id: string }>(
          db,
          `SELECT tag_id FROM subscription_tags WHERE subscription_id = ${q(subMergeSource)}`
        )
      ).map((r) => r.tag_id);
      const now = ts(nowIso());
      return {
        statements: [
          lockMembersSql(
            U0,
            `(subscriptions.id = ${q(subMergeSource)} OR subscriptions.feed_id = ${q(newFeed)})`
          ),
          {
            label: "lock_old",
            sql: `SELECT subscriptions.feed_id, subscriptions.custom_title, subscriptions.fetch_full_content
FROM subscriptions
WHERE subscriptions.id = ${q(subMergeSource)} AND subscriptions.user_id = ${q(U0)}
  AND subscriptions.unsubscribed_at IS NULL
FOR UPDATE`,
          },
          {
            label: "upsert_survivor",
            sql: `INSERT INTO subscriptions (id, user_id, feed_id, type, subscribed_at, created_at, updated_at, custom_title, fetch_full_content)
VALUES (${q(survivor)}, ${q(U0)}, ${q(newFeed)}, 'web', ${now}, ${now}, ${now}, ${q(old.custom_title)}, false)
ON CONFLICT (user_id, feed_id) DO UPDATE SET
  unsubscribed_at = NULL, subscribed_at = EXCLUDED.subscribed_at, updated_at = EXCLUDED.updated_at,
  custom_title = EXCLUDED.custom_title, fetch_full_content = EXCLUDED.fetch_full_content
WHERE subscriptions.unsubscribed_at IS NOT NULL
RETURNING id`,
          },
          {
            label: "select_survivor",
            sql: `SELECT subscriptions.id, subscriptions.subscribed_at, subscriptions.custom_title FROM subscriptions
WHERE subscriptions.user_id = ${q(U0)} AND subscriptions.feed_id = ${q(newFeed)}`,
          },
          {
            label: "copy_memberships",
            sql: `INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at,
                                  read, starred, is_spam)
SELECT ${q(survivor)}::uuid, user_id, entry_id, published_or_fetched_at, read, starred, is_spam
FROM subscription_entries
WHERE subscription_id = ${q(subMergeSource)}
ON CONFLICT DO NOTHING`,
          },
          {
            label: "clear_survivor_tags",
            sql: `DELETE FROM subscription_tags WHERE subscription_tags.subscription_id = ${q(survivor)}`,
          },
          populateSql(U0, survivor, newFeed),
          {
            label: "move_tags.delete",
            sql: `DELETE FROM subscription_tags WHERE subscription_tags.subscription_id = ${q(subMergeSource)}
RETURNING subscription_tags.tag_id`,
          },
          ...(movedTags.length > 0
            ? [
                {
                  label: "move_tags.insert",
                  sql: `INSERT INTO subscription_tags (subscription_id, tag_id)
VALUES ${movedTags.map((t) => `(${q(survivor)}, ${q(t)})`).join(", ")}
ON CONFLICT DO NOTHING RETURNING subscription_tags.tag_id`,
                },
              ]
            : []),
          {
            label: "unsubscribe_old",
            sql: `UPDATE subscriptions SET unsubscribed_at = ${now}, updated_at = ${now}
WHERE subscriptions.id = ${q(subMergeSource)}`,
          },
          {
            label: "survivor_tags",
            sql: `SELECT tags.id, tags.name, tags.color FROM subscription_tags
INNER JOIN tags ON tags.id = subscription_tags.tag_id
WHERE subscription_tags.subscription_id = ${q(survivor)}`,
          },
          ensureFeedJobSql(newFeed),
          userCountsSql(U0),
          {
            label: "counts.subscriptions",
            sql: `SELECT subscriptions.id, subscriptions.unread_count FROM subscriptions
WHERE subscriptions.user_id = ${q(U0)} AND subscriptions.id IN (${q(survivor)})`,
          },
          {
            label: "counts.subscription_tags",
            sql: `SELECT subscription_tags.subscription_id, subscription_tags.tag_id FROM subscription_tags
WHERE subscription_tags.subscription_id IN (${q(survivor)})`,
          },
          ...(movedTags.length > 0 ? [tagCountsSql(U0, movedTags)] : []),
        ],
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
        statements: [
          {
            label: "existing",
            sql: `SELECT entries.id FROM entries
INNER JOIN user_entries ON user_entries.entry_id = entries.id
WHERE entries.id = ${q(id)} AND entries.owner_user_id = ${q(U0)} AND user_entries.user_id = ${q(U0)}
LIMIT 1`,
          },
          {
            label: "collections",
            sql: `SELECT subscription_entries.subscription_id FROM subscription_entries
INNER JOIN subscriptions ON subscriptions.id = subscription_entries.subscription_id
WHERE subscription_entries.user_id = ${q(U0)} AND subscription_entries.entry_id = ${q(id)}
  AND ${IS_COLLECTION} AND subscriptions.unsubscribed_at IS NULL
ORDER BY subscription_entries.subscription_id`,
          },
          {
            label: "delete_entry",
            sql: `DELETE FROM entries WHERE entries.id = ${q(id)} AND entries.owner_user_id = ${q(U0)}`,
          },
          {
            label: "tombstone",
            sql: `INSERT INTO entry_tombstones (user_id, entry_id) VALUES (${q(U0)}, ${q(id)})
ON CONFLICT (user_id, entry_id) DO UPDATE SET deleted_at = now()`,
          },
        ],
      };
    },
  },
  {
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
