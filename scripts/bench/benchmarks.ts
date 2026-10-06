/**
 * The database benchmarks: each one reproduces, statement by statement, the
 * SQL a service function sends for one user action, against the seeded
 * dataset (`seed.ts`). Each cites the function it mirrors; **when that
 * function's SQL changes, change the benchmark with it**, or before/after
 * comparisons measure the wrong thing.
 *
 * Values are inlined as literals where the app binds parameters; the planner
 * sees the same values either way. Writes run inside a transaction that is
 * rolled back (`run.ts`), so every iteration starts from the same data.
 */

import type { ClientBase } from "pg";

import {
  COLLECTIONS,
  U0,
  WEB,
  benchUuid,
  collectionSubscriptionId,
  prng,
  savedFeedId,
  searchQuery,
  tagId,
  vocabulary,
  webFeedId,
  webFeedUrl,
  webSubscriptionId,
} from "./dataset";

export interface Statement {
  /** Short name, unique within the benchmark (e.g. "update", "counts.users"). */
  label: string;
  sql: string;
}

export interface PreparedBenchmark {
  /** Run inside the write transaction before the measured statements, unmeasured. */
  setup?: string[];
  statements: Statement[];
}

export interface Benchmark {
  name: string;
  kind: "read" | "write";
  /** The service function(s) whose SQL this reproduces. */
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
const IS_COLLECTION =
  "EXISTS (SELECT 1 FROM feeds WHERE feeds.id = subscriptions.feed_id AND feeds.type = 'collection')";

/** `entryListSelectFields` + `entryFeedTitleSql()` (services/entries.ts, entry-filters.ts). */
const LIST_COLUMNS = `ve.id, ve.greader_item_id, ve.subscription_greader_stream_id, feeds.greader_stream_id,
  ve.type, ve.url, ve.title, ve.author, ve.summary, ve.published_at, ve.fetched_at, ve.read,
  ve.starred, ve.read_changed_at, ve.updated_at, ve.subscription_id, ve.site_name,
  COALESCE(subscriptions.custom_title, feeds.title) AS feed_title`;

/** `entryFullSelectFields` + `shownFullContentSelectFields` (getEntries/getEntry). */
const FULL_COLUMNS = `ve.id, ve.greader_item_id, ve.subscription_greader_stream_id, feeds.greader_stream_id,
  ve.type, ve.url, ve.title, ve.author, ve.content_original, ve.content_cleaned, ve.summary,
  ve.published_at, ve.fetched_at, ve.read, ve.starred, ve.updated_at, ve.subscription_id, ve.site_name,
  COALESCE(subscriptions.custom_title, feeds.title) AS feed_title, feeds.url AS feed_url, ve.unsubscribe_url,
  CASE WHEN subscriptions.fetch_full_content THEN COALESCE(ve.full_content_cleaned, ve.full_content_original) END AS full_content,
  ve.full_content_fetched_at, ve.full_content_error, subscriptions.fetch_full_content`;

/** The joins every entry read performs (`entrySubscriptionJoin`). */
const FROM_VISIBLE = `FROM visible_entries ve
INNER JOIN feeds ON ve.feed_id = feeds.id
LEFT JOIN subscriptions ON subscriptions.id = ve.subscription_id AND subscriptions.user_id = ve.user_id`;

interface ListOptions {
  userId: string;
  where?: string[];
  unreadOnly?: boolean;
  limit?: number;
  sortBy?: "published" | "readChanged";
  cursor?: { ts: string; id: string };
}

/** `listEntries` (services/entries.ts), newest first; `limit` is the page size. */
function listEntriesSql(o: ListOptions): string {
  const sortColumn =
    o.sortBy === "readChanged" ? "ve.read_changed_at" : "ve.published_or_fetched_at";
  const where = [`ve.user_id = ${q(o.userId)}`, ...(o.where ?? [])];
  if (o.unreadOnly ?? true) where.push("ve.read = false");
  where.push("ve.is_spam = false");
  if (o.sortBy === "readChanged") where.push("ve.read_changed_at IS NOT NULL");
  if (o.cursor) {
    where.push(
      `(${sortColumn} < ${ts(o.cursor.ts)} OR (${sortColumn} = ${ts(o.cursor.ts)} AND ve.id < ${q(o.cursor.id)}))`
    );
  }
  return `SELECT ${LIST_COLUMNS}, ${sortColumn} AS sort_ts
${FROM_VISIBLE}
WHERE ${where.join("\n  AND ")}
ORDER BY ${sortColumn} DESC, ve.id DESC
LIMIT ${(o.limit ?? 10) + 1} OFFSET 0`;
}

/** `getEntries` (services/entries.ts). */
function getEntriesSql(userId: string, entryIds: string[]): string {
  return `SELECT ${FULL_COLUMNS}
${FROM_VISIBLE}
WHERE ve.id IN (${list(entryIds)}) AND ve.user_id = ${q(userId)}`;
}

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

/** `buildTaggedSubscriptionIdsSubquery` (services/entry-filters.ts). */
const taggedSubscriptionIds = (
  userId: string,
  tag: string
): string => `SELECT subscription_tags.subscription_id
FROM subscription_tags
INNER JOIN tags ON subscription_tags.tag_id = tags.id AND tags.user_id = ${q(userId)} AND tags.deleted_at IS NULL
INNER JOIN subscriptions ON subscriptions.id = subscription_tags.subscription_id AND subscriptions.unsubscribed_at IS NULL
WHERE subscription_tags.tag_id = ${q(tag)}`;

/** `buildUncategorizedSubscriptionIdsSubquery` (services/entry-filters.ts). */
const uncategorizedSubscriptionIds = (userId: string): string => `SELECT subscriptions.id
FROM subscriptions
LEFT JOIN subscription_tags ON subscription_tags.subscription_id = subscriptions.id
WHERE subscriptions.user_id = ${q(userId)} AND subscriptions.unsubscribed_at IS NULL
  AND subscription_tags.subscription_id IS NULL`;

/**
 * `buildEntriesInSubscriptionsCondition` (services/entry-filters.ts): its
 * collection lookup (run here to pick the condition's shape, and returned as
 * a statement since the service runs it too) and the condition.
 */
async function entriesInSubscriptions(
  db: ClientBase,
  userId: string,
  ids: string[] | { subquery: string },
  columns: { entryId: string; subscriptionId: string }
): Promise<{ lookup: Statement; condition: string }> {
  const idsSql = Array.isArray(ids) ? list(ids) : ids.subquery;
  const lookupSql = `SELECT subscriptions.id FROM subscriptions
WHERE subscriptions.user_id = ${q(userId)} AND ${IS_COLLECTION}
  AND subscriptions.id IN (${idsSql})`;
  const collections = (await rows<{ id: string }>(db, lookupSql)).map((r) => r.id);
  const feedArm = `${columns.subscriptionId} IN (${idsSql})`;
  const lookup = { label: "collection_lookup", sql: lookupSql };
  if (collections.length === 0) return { lookup, condition: feedArm };
  const collectionArm = `EXISTS (SELECT 1 FROM collection_entries
  WHERE collection_entries.user_id = ${q(userId)} AND collection_entries.entry_id = ${columns.entryId}
    AND collection_entries.subscription_id IN (${list(collections)}))`;
  const onlyCollections = Array.isArray(ids) && ids.every((id) => collections.includes(id));
  return {
    lookup,
    condition: onlyCollections ? collectionArm : `(${feedArm} OR ${collectionArm})`,
  };
}

const VE_COLUMNS = { entryId: "ve.id", subscriptionId: "ve.subscription_id" };
const UE_COLUMNS = {
  entryId: "user_entries.entry_id",
  subscriptionId: "user_entries.subscription_id",
};

/** `getUserUnreadCounts` (services/counts.ts). */
const userCountsSql = (userId: string): Statement => ({
  label: "counts.users",
  sql: `SELECT all_unread_count, starred_unread_count, saved_unread_count, uncategorized_unread_count
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
  let collectionIds: string[] = [];
  if (entryIds.length > 0) {
    const sql = `SELECT DISTINCT collection_entries.subscription_id FROM collection_entries
WHERE collection_entries.user_id = ${q(userId)} AND collection_entries.entry_id = ANY(${uuidArray(entryIds)})`;
    collectionIds = (await rows<{ subscription_id: string }>(db, sql)).map(
      (r) => r.subscription_id
    );
    out.push({ label: "counts.collections", sql });
  }
  const subscriptionIds = [
    ...new Set([
      ...entries.flatMap((e) => (e.subscriptionId ? [e.subscriptionId] : [])),
      ...collectionIds,
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

/** `populateInitialUserEntries` (services/subscriptions.ts). */
const populateSql = (userId: string, subscriptionId: string, feedId: string): Statement => ({
  label: "populate",
  sql: `INSERT INTO user_entries (user_id, entry_id, published_or_fetched_at, subscription_id, is_spam, read)
SELECT ${q(userId)}, e.id, COALESCE(e.published_at, e.fetched_at), ${q(subscriptionId)}, e.is_spam, e.is_backfill
FROM entries e
JOIN feeds f ON f.id = e.feed_id
WHERE e.feed_id = ${q(feedId)}
  AND f.last_entries_updated_at IS NOT NULL
  AND e.last_seen_at >= f.last_entries_updated_at
  AND NOT EXISTS (
    SELECT 1
    FROM user_entries ue_existing
    JOIN entries e_prev ON ue_existing.entry_id = e_prev.id
    WHERE ue_existing.user_id = ${q(userId)}
      AND ue_existing.subscription_id = ${q(subscriptionId)}
      AND e_prev.feed_id != e.feed_id
      AND regexp_replace(e_prev.guid, '^https?://', 'https://') = regexp_replace(e.guid, '^https?://', 'https://')
  )
ON CONFLICT DO NOTHING`,
});

/** `unsubscribe` (services/subscriptions.ts), from its existence check to its counts. */
async function unsubscribeStatements(
  db: ClientBase,
  userId: string,
  subscriptionId: string
): Promise<Statement[]> {
  const sub = `subscriptions.id = ${q(subscriptionId)} AND subscriptions.user_id = ${q(userId)}`;
  const now = ts(nowIso());
  const formerTags = (
    await rows<{ tag_id: string }>(
      db,
      `SELECT tag_id FROM subscription_tags WHERE subscription_id = ${q(subscriptionId)}`
    )
  ).map((r) => r.tag_id);
  return [
    {
      label: "existing",
      sql: `SELECT feeds.* FROM subscriptions INNER JOIN feeds ON subscriptions.feed_id = feeds.id
WHERE ${sub} AND subscriptions.unsubscribed_at IS NULL LIMIT 1`,
    },
    // lockSubscriptionRow(..., { members: true })
    {
      label: "lock_members",
      sql: `SELECT user_entries.entry_id FROM user_entries
INNER JOIN collection_entries ON collection_entries.user_id = user_entries.user_id
  AND collection_entries.entry_id = user_entries.entry_id
WHERE collection_entries.subscription_id = ${q(subscriptionId)} AND collection_entries.user_id = ${q(userId)}
ORDER BY user_entries.entry_id
FOR NO KEY UPDATE OF user_entries`,
    },
    {
      label: "lock_subscription",
      sql: `SELECT subscriptions.id FROM subscriptions WHERE ${sub} FOR UPDATE`,
    },
    {
      label: "soft_delete",
      sql: `UPDATE subscriptions SET unsubscribed_at = ${now}, updated_at = ${now}
WHERE ${sub} AND subscriptions.unsubscribed_at IS NULL
RETURNING subscriptions.id`,
    },
    {
      label: "delete_tags",
      sql: `DELETE FROM subscription_tags
WHERE subscription_tags.subscription_id IN (SELECT subscriptions.id FROM subscriptions WHERE ${sub})
RETURNING subscription_tags.tag_id`,
    },
    // getSubscriptionDeletionCounts
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
      sql: `SELECT count(*)::int FROM collection_entries WHERE collection_entries.subscription_id = ${q(collection)}`,
    },
    {
      label: "insert",
      sql: `INSERT INTO collection_entries (subscription_id, user_id, entry_id, created_at)
SELECT ${q(collection)}::uuid AS subscription_id, ve.user_id, ve.id, now() AS created_at
FROM visible_entries ve
WHERE ve.user_id = ${q(userId)} AND ve.id IN (${ids})
ON CONFLICT DO NOTHING
RETURNING collection_entries.entry_id`,
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

/** U0's newest unread web entry in a tagged subscription and no collection. */
async function plainUnreadEntry(db: ClientBase): Promise<{ id: string; subscription_id: string }> {
  return one(
    db,
    `SELECT ue.entry_id AS id, ue.subscription_id FROM user_entries ue
JOIN subscriptions s ON s.id = ue.subscription_id AND s.unsubscribed_at IS NULL
WHERE ue.user_id = ${q(U0)} AND NOT ue.read AND NOT ue.starred AND NOT ue.is_spam
  AND EXISTS (SELECT 1 FROM subscription_tags st WHERE st.subscription_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM collection_entries ce WHERE ce.user_id = ue.user_id AND ce.entry_id = ue.entry_id)
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
  AND NOT EXISTS (SELECT 1 FROM collection_entries ce WHERE ce.user_id = ve.user_id AND ce.entry_id = ve.id)
ORDER BY ve.published_or_fetched_at DESC, ve.id DESC LIMIT ${n}`
    )
  ).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const READS: Benchmark[] = [
  {
    name: "ssr.tags_list",
    kind: "read",
    source: "services/tags.ts listTags",
    prepare: async () => ({
      statements: [
        {
          label: "tags",
          sql: `SELECT tags.id, tags.name, tags.color, tags.created_at,
  (SELECT COUNT(*)::int FROM subscription_tags WHERE subscription_tags.tag_id = "tags"."id") AS feed_count,
  tags.unread_count
FROM tags WHERE tags.user_id = ${q(U0)} AND tags.deleted_at IS NULL ORDER BY tags.name`,
        },
        {
          label: "uncategorized_feeds",
          sql: `SELECT COUNT(*)::int FROM subscriptions
WHERE subscriptions.user_id = ${q(U0)} AND subscriptions.unsubscribed_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM subscription_tags WHERE subscription_tags.subscription_id = subscriptions.id)`,
        },
        {
          label: "uncategorized_unread",
          sql: `SELECT uncategorized_unread_count FROM users WHERE users.id = ${q(U0)}`,
        },
      ],
    }),
  },
  {
    name: "ssr.entries_count",
    kind: "read",
    source: "services/counts.ts getUserUnreadCounts (entries.count, run 3× per SSR)",
    prepare: async () => ({ statements: [userCountsSql(U0)] }),
  },
  {
    name: "ssr.sync_cursors",
    kind: "read",
    source: "trpc/routers/sync.ts currentSyncCursors",
    prepare: async () => ({
      statements: [
        {
          label: "entries",
          sql: `WITH arm_ue AS (
  SELECT ue.updated_at AS ts, ue.entry_id AS id FROM user_entries ue
  WHERE ue.user_id = ${q(U0)}::uuid ORDER BY ue.updated_at DESC, ue.entry_id DESC LIMIT 1
),
bound AS (SELECT COALESCE((SELECT ts FROM arm_ue), '-infinity'::timestamptz) AS ts),
arm_sub AS (
  SELECT e.updated_at AS ts, e.id FROM subscriptions s
  JOIN entries e ON e.feed_id = s.feed_id AND e.updated_at >= (SELECT ts FROM bound)
  JOIN user_entries ue2 ON ue2.entry_id = e.id AND ue2.user_id = ${q(U0)}::uuid
  WHERE s.user_id = ${q(U0)}::uuid ORDER BY e.updated_at DESC, e.id DESC LIMIT 1
),
arm_saved AS (
  SELECT e.updated_at AS ts, e.id FROM entries e
  JOIN user_entries ue2 ON ue2.entry_id = e.id AND ue2.user_id = ${q(U0)}::uuid
  WHERE e.feed_id = (SELECT id FROM feeds WHERE user_id = ${q(U0)}::uuid AND type = 'saved')
    AND e.updated_at >= (SELECT ts FROM bound)
  ORDER BY e.updated_at DESC, e.id DESC LIMIT 1
)
SELECT ts, id FROM (
  SELECT ts, id FROM arm_ue UNION ALL SELECT ts, id FROM arm_sub UNION ALL SELECT ts, id FROM arm_saved
) c WHERE ts IS NOT NULL ORDER BY ts DESC, id DESC LIMIT 1`,
        },
        {
          label: "subscriptions",
          sql: `SELECT MAX(subscriptions.updated_at) FROM subscriptions WHERE subscriptions.user_id = ${q(U0)}`,
        },
        {
          label: "tags",
          sql: `SELECT MAX(tags.updated_at) FROM tags WHERE tags.user_id = ${q(U0)}`,
        },
      ],
    }),
  },
  {
    name: "ssr.list_all",
    kind: "read",
    source: "services/entries.ts listEntries (/all, unread, first page)",
    prepare: async () => ({ statements: [{ label: "list", sql: listEntriesSql({ userId: U0 }) }] }),
  },
  {
    name: "ssr.list_all_page_20",
    kind: "read",
    source: "services/entries.ts listEntries (/all, unread, keyset cursor 200 rows deep)",
    prepare: async (db) => {
      const cursor = await one<{ ts: string; id: string }>(
        db,
        `SELECT published_or_fetched_at::text AS ts, id FROM visible_entries
WHERE user_id = ${q(U0)} AND read = false AND is_spam = false
ORDER BY published_or_fetched_at DESC, id DESC OFFSET 200 LIMIT 1`
      );
      return { statements: [{ label: "list", sql: listEntriesSql({ userId: U0, cursor }) }] };
    },
  },
  {
    name: "ssr.list_subscription",
    kind: "read",
    source:
      "services/entries.ts listEntries (/subscription/:id, U0's subscription with most unread)",
    prepare: async (db) => {
      const { id } = await one<{ id: string }>(
        db,
        `SELECT id FROM subscriptions WHERE user_id = ${q(U0)} AND unsubscribed_at IS NULL
ORDER BY unread_count DESC, id LIMIT 1`
      );
      const filter = await entriesInSubscriptions(db, U0, [id], VE_COLUMNS);
      return {
        statements: [
          verifyOwnershipSql(U0, id),
          filter.lookup,
          { label: "list", sql: listEntriesSql({ userId: U0, where: [filter.condition] }) },
        ],
      };
    },
  },
  {
    name: "ssr.list_tag",
    kind: "read",
    source: "services/entries.ts listEntries (/tag/:id; the tag also holds a collection)",
    prepare: async (db) => {
      const filter = await entriesInSubscriptions(
        db,
        U0,
        { subquery: taggedSubscriptionIds(U0, tagId(0, 1)) },
        VE_COLUMNS
      );
      return {
        statements: [
          filter.lookup,
          { label: "list", sql: listEntriesSql({ userId: U0, where: [filter.condition] }) },
        ],
      };
    },
  },
  {
    name: "ssr.list_starred",
    kind: "read",
    source: "services/entries.ts listEntries (/starred)",
    prepare: async () => ({
      statements: [
        { label: "list", sql: listEntriesSql({ userId: U0, where: ["ve.starred = true"] }) },
      ],
    }),
  },
  {
    name: "ssr.list_saved",
    kind: "read",
    source: "services/entries.ts listEntries (/saved)",
    prepare: async () => ({
      statements: [
        { label: "list", sql: listEntriesSql({ userId: U0, where: ["ve.type = 'saved'"] }) },
      ],
    }),
  },
  {
    name: "ssr.list_uncategorized",
    kind: "read",
    source: "services/entries.ts listEntries (/uncategorized; includes untagged collections)",
    prepare: async (db) => {
      const filter = await entriesInSubscriptions(
        db,
        U0,
        { subquery: uncategorizedSubscriptionIds(U0) },
        VE_COLUMNS
      );
      return {
        statements: [
          filter.lookup,
          { label: "list", sql: listEntriesSql({ userId: U0, where: [filter.condition] }) },
        ],
      };
    },
  },
  {
    name: "ssr.list_recently_read",
    kind: "read",
    source: "services/entries.ts listEntries (/recently-read)",
    prepare: async () => ({
      statements: [
        {
          label: "list",
          sql: listEntriesSql({ userId: U0, unreadOnly: false, sortBy: "readChanged" }),
        },
      ],
    }),
  },
  {
    name: "ssr.entries_get",
    kind: "read",
    source: "services/entries.ts selectFullEntry (entries.get)",
    prepare: async (db) => {
      const { id } = await plainUnreadEntry(db);
      return {
        statements: [
          {
            label: "get",
            sql: `SELECT ${FULL_COLUMNS}, ve.full_content_original, ve.full_content_cleaned, ve.content_hash, ve.read_changed_at
${FROM_VISIBLE}
WHERE ve.id = ${q(id)} AND ve.user_id = ${q(U0)}
LIMIT 1`,
          },
        ],
      };
    },
  },
  {
    name: "ssr.subscriptions_get",
    kind: "read",
    source: "services/subscriptions.ts getSubscription",
    prepare: async () => ({
      statements: [
        {
          label: "get",
          sql: `SELECT user_feeds.id, user_feeds.subscribed_at, user_feeds.feed_id, user_feeds.fetch_full_content,
  user_feeds.type, user_feeds.url, user_feeds.title, user_feeds.original_title, user_feeds.description,
  user_feeds.site_url, user_feeds.unread_count,
  COALESCE(json_agg(json_build_object('id', tags.id, 'name', tags.name, 'color', tags.color))
           FILTER (WHERE tags.id IS NOT NULL), '[]'::json) AS tags
FROM user_feeds
LEFT JOIN subscription_tags ON subscription_tags.subscription_id = user_feeds.id
LEFT JOIN tags ON tags.id = subscription_tags.tag_id
WHERE user_feeds.id = ${q(subLarge)} AND user_feeds.user_id = ${q(U0)}
GROUP BY user_feeds.id, user_feeds.subscribed_at, user_feeds.feed_id, user_feeds.fetch_full_content,
  user_feeds.type, user_feeds.url, user_feeds.title, user_feeds.original_title, user_feeds.description,
  user_feeds.site_url, user_feeds.unread_count
LIMIT 1`,
        },
      ],
    }),
  },
  {
    name: "list.collection",
    kind: "read",
    source: "services/entries.ts listEntries (/subscription/:id for a collection, unread)",
    prepare: async (db) => {
      const filter = await entriesInSubscriptions(db, U0, [readingList], VE_COLUMNS);
      return {
        statements: [
          verifyOwnershipSql(U0, readingList),
          filter.lookup,
          { label: "list", sql: listEntriesSql({ userId: U0, where: [filter.condition] }) },
        ],
      };
    },
  },
  {
    name: "list.mostly_read_feed_unread",
    kind: "read",
    source: "services/entries.ts listEntries (unread only, 3,000-entry feed with 40 unread)",
    prepare: async (db) => {
      const filter = await entriesInSubscriptions(db, U0, [subMostlyRead], VE_COLUMNS);
      return {
        statements: [
          verifyOwnershipSql(U0, subMostlyRead),
          filter.lookup,
          { label: "list", sql: listEntriesSql({ userId: U0, where: [filter.condition] }) },
        ],
      };
    },
  },
  {
    name: "search",
    kind: "read",
    source: "services/entries.ts searchEntries (all entries, two-word query)",
    prepare: async () => {
      const tsq = `plainto_tsquery('english', ${q(searchQuery())})`;
      return {
        statements: [
          {
            label: "search",
            sql: `SELECT * FROM (
  SELECT ${LIST_COLUMNS}, ts_rank(ve.search_vector, ${tsq}) AS rank
  ${FROM_VISIBLE}
  WHERE ve.user_id = ${q(U0)} AND ve.search_vector @@ ${tsq} AND ve.is_spam = false
) ranked
ORDER BY ranked.rank DESC, ranked.id DESC
LIMIT 11 OFFSET 0`,
          },
        ],
      };
    },
  },
  {
    name: "sync.events",
    kind: "read",
    source:
      "trpc/routers/sync.ts collectSyncEvents (entry + subscription + tag arms, ~200 changes)",
    prepare: async (db) => {
      const cursor = await one<{ ts: string; id: string }>(
        db,
        `SELECT updated_at::text AS ts, entry_id AS id FROM user_entries WHERE user_id = ${q(U0)}
ORDER BY updated_at DESC, entry_id DESC OFFSET 200 LIMIT 1`
      );
      const subCursor = await one<{ ts: string }>(
        db,
        `SELECT updated_at::text AS ts FROM subscriptions WHERE user_id = ${q(U0)}
ORDER BY updated_at DESC OFFSET 5 LIMIT 1`
      );
      const tagCursor = await one<{ ts: string }>(
        db,
        `SELECT max(updated_at)::text AS ts FROM tags WHERE user_id = ${q(U0)}`
      );
      const c = ts(cursor.ts);
      const after = (col: string) =>
        `(${col} > ${c} OR (${col} = ${c} AND entries.id > ${q(cursor.id)}::uuid))`;
      const greatest = "GREATEST(entries.updated_at, user_entries.updated_at)";
      const visible = `((subscriptions.id IS NOT NULL AND subscriptions.unsubscribed_at IS NULL) OR user_entries.starred = true OR entries.type = 'saved'
    OR EXISTS (SELECT 1 FROM collection_entries ce WHERE ce.user_id = user_entries.user_id AND ce.entry_id = user_entries.entry_id))`;
      const saved = savedFeedId(0);
      const entriesSql = `WITH changed_entries AS (
  (SELECT user_entries.entry_id FROM user_entries
   WHERE user_entries.user_id = ${q(U0)} AND user_entries.updated_at >= ${c})
  UNION
  (SELECT user_entries.entry_id FROM subscriptions
   INNER JOIN entries ON entries.feed_id = subscriptions.feed_id AND entries.updated_at >= ${c}
   INNER JOIN user_entries ON user_entries.entry_id = entries.id AND user_entries.user_id = subscriptions.user_id
   WHERE subscriptions.user_id = ${q(U0)})
  UNION
  (SELECT user_entries.entry_id FROM user_entries
   INNER JOIN entries ON entries.id = user_entries.entry_id AND entries.feed_id = ${q(saved)} AND entries.updated_at >= ${c}
   WHERE user_entries.user_id = ${q(U0)})
)
SELECT entries.id, entries.title, entries.author, entries.summary, entries.url, entries.published_at,
  entries.fetched_at, entries.site_name, entries.is_spam, entries.is_backfill, user_entries.read,
  user_entries.starred, user_entries.read_changed_at, subscriptions.id AS subscription_id, entries.type,
  COALESCE(subscriptions.custom_title, feeds.title) AS feed_title,
  ${visible} AS visible,
  ${after("entries.updated_at")} AS metadata_changed,
  ${after("user_entries.updated_at")} AS state_changed,
  ${after("entries.created_at")} AS is_new,
  ${greatest} AS max_updated_at, user_entries.updated_at AS state_updated_at
FROM changed_entries
INNER JOIN user_entries ON user_entries.user_id = ${q(U0)} AND user_entries.entry_id = changed_entries.entry_id
INNER JOIN entries ON entries.id = user_entries.entry_id
INNER JOIN feeds ON feeds.id = entries.feed_id
LEFT JOIN subscriptions ON subscriptions.id = user_entries.subscription_id AND subscriptions.user_id = user_entries.user_id
WHERE ${after(greatest)} AND ${visible}
ORDER BY ${greatest}, entries.id
LIMIT 501`;
      const changed = await rows<{
        id: string;
        subscription_id: string | null;
        state_changed: boolean;
        metadata_changed: boolean;
        is_new: boolean;
      }>(db, entriesSql);
      const subsSql = `SELECT subscriptions.*, feeds.*, subscriptions.updated_at AS updated_at_instant
FROM subscriptions INNER JOIN feeds ON subscriptions.feed_id = feeds.id
WHERE subscriptions.user_id = ${q(U0)} AND subscriptions.updated_at > ${ts(subCursor.ts)}
ORDER BY subscriptions.updated_at`;
      const activeSubs = (
        await rows<{ id: string; unsubscribed_at: string | null }>(
          db,
          `SELECT id, unsubscribed_at FROM subscriptions WHERE user_id = ${q(U0)} AND updated_at > ${ts(subCursor.ts)}`
        )
      ).filter((s) => s.unsubscribed_at === null);
      const toCountEntries = (rowsIn: typeof changed) =>
        rowsIn.map((r) => ({ id: r.id, subscriptionId: r.subscription_id }));
      const newEntries = changed.filter((r) => r.metadata_changed && r.is_new);
      const stateChanged = changed.filter((r) => r.state_changed);
      const prefixed = (prefix: string, statements: Statement[]) =>
        statements.map((s) => ({ ...s, label: `${prefix}.${s.label}` }));
      return {
        statements: [
          {
            label: "saved_feed",
            sql: `SELECT feeds.id FROM feeds WHERE feeds.type = 'saved' AND feeds.user_id = ${q(U0)} LIMIT 1`,
          },
          { label: "entries", sql: entriesSql },
          ...(newEntries.length > 0
            ? prefixed("new", await bulkCounts(db, U0, toCountEntries(newEntries)))
            : []),
          ...(stateChanged.length > 0
            ? prefixed("state", await bulkCounts(db, U0, toCountEntries(stateChanged)))
            : []),
          { label: "subscriptions", sql: subsSql },
          ...(activeSubs.length > 0
            ? [
                {
                  label: "subscription_tags",
                  sql: `SELECT subscription_tags.subscription_id, tags.id, tags.name, tags.color
FROM subscription_tags INNER JOIN tags ON tags.id = subscription_tags.tag_id
WHERE subscription_tags.subscription_id IN (${list(activeSubs.map((s) => s.id))})`,
                },
              ]
            : []),
          {
            label: "tags",
            sql: `SELECT tags.id, tags.name, tags.color, tags.created_at, tags.deleted_at, tags.updated_at
FROM tags WHERE tags.user_id = ${q(U0)} AND tags.updated_at > ${ts(tagCursor.ts)} ORDER BY tags.updated_at`,
          },
        ],
      };
    },
  },
  {
    name: "greader.stream_feed",
    kind: "read",
    source:
      "greader stream/contents route: resolveFeedStream + listEntries + getEntries (feed/{n}, n=20)",
    prepare: async (db) => {
      const { stream } = await one<{ stream: string }>(
        db,
        `SELECT greader_stream_id::text AS stream FROM subscriptions WHERE id = ${q(subA)}`
      );
      const filter = await entriesInSubscriptions(db, U0, [subA], VE_COLUMNS);
      const listSql = listEntriesSql({
        userId: U0,
        where: [filter.condition],
        unreadOnly: false,
        limit: 20,
      });
      const ids = (await rows<{ id: string }>(db, listSql)).slice(0, 20).map((r) => r.id);
      return {
        statements: [
          {
            label: "resolve_stream",
            sql: `SELECT subscriptions.id FROM subscriptions
WHERE subscriptions.user_id = ${q(U0)} AND subscriptions.greader_stream_id = ${stream} LIMIT 1`,
          },
          verifyOwnershipSql(U0, subA),
          filter.lookup,
          { label: "list", sql: listSql },
          { label: "get_entries", sql: getEntriesSql(U0, ids) },
        ],
      };
    },
  },
  {
    name: "greader.stream_saved",
    kind: "read",
    source:
      "greader stream/contents route: resolveFeedStream + listEntries + getEntries (Saved, n=20)",
    prepare: async (db) => {
      const { stream } = await one<{ stream: string }>(
        db,
        `SELECT greader_stream_id::text AS stream FROM feeds WHERE id = ${q(savedFeedId(0))}`
      );
      const listSql = listEntriesSql({
        userId: U0,
        where: ["ve.type = 'saved'"],
        unreadOnly: false,
        limit: 20,
      });
      const ids = (await rows<{ id: string }>(db, listSql)).slice(0, 20).map((r) => r.id);
      return {
        statements: [
          {
            label: "resolve_subscription",
            sql: `SELECT subscriptions.id FROM subscriptions
WHERE subscriptions.user_id = ${q(U0)} AND subscriptions.greader_stream_id = ${stream} LIMIT 1`,
          },
          {
            label: "resolve_saved",
            sql: `SELECT feeds.id FROM feeds
WHERE feeds.user_id = ${q(U0)} AND feeds.type = 'saved' AND feeds.greader_stream_id = ${stream} LIMIT 1`,
          },
          { label: "list", sql: listSql },
          { label: "get_entries", sql: getEntriesSql(U0, ids) },
        ],
      };
    },
  },
  {
    name: "greader.unread_count",
    kind: "read",
    source: "google-reader/subscriptions.ts getGreaderUnreadCounts",
    prepare: async () => ({
      statements: [
        {
          label: "counts",
          sql: `SELECT subscriptions.greader_stream_id AS stream_id, subscriptions.unread_count AS unread, latest.newest AS newest
FROM subscriptions
LEFT JOIN LATERAL (
  SELECT ue.published_or_fetched_at AS newest FROM user_entries ue
  WHERE ue.subscription_id = subscriptions.id
  ORDER BY ue.published_or_fetched_at DESC, ue.entry_id DESC LIMIT 1
) latest ON true
WHERE subscriptions.user_id = ${q(U0)}::uuid AND subscriptions.unsubscribed_at IS NULL AND NOT ${IS_COLLECTION}
UNION ALL
SELECT f.greader_stream_id AS stream_id, u.saved_unread_count AS unread, latest.newest AS newest
FROM feeds f
JOIN users u ON u.id = f.user_id
LEFT JOIN LATERAL (
  SELECT COALESCE(e.published_at, e.fetched_at) AS newest FROM entries e
  JOIN user_entries ue ON ue.user_id = f.user_id AND ue.entry_id = e.id
  WHERE e.feed_id = f.id
  ORDER BY COALESCE(e.published_at, e.fetched_at) DESC, e.id DESC LIMIT 1
) latest ON true
WHERE f.type = 'saved' AND f.user_id = ${q(U0)}::uuid`,
        },
        userCountsSql(U0),
      ],
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
 * check, `updateEntriesLastSeenAt` and `createUserEntriesForFeed`.
 */
async function fetchStatements(db: ClientBase, fresh: number, kept: number): Promise<Statement[]> {
  const feedId = webFeedId(WEB.popular);
  const feed = await one<{ last_entries_updated_at: string }>(
    db,
    `SELECT last_entries_updated_at::text FROM feeds WHERE id = ${q(feedId)}`
  );
  const current = await rows<{ id: string; guid: string }>(
    db,
    `SELECT id, guid FROM entries WHERE feed_id = ${q(feedId)} AND last_seen_at >= ${ts(feed.last_entries_updated_at)}
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
WHERE entries.feed_id = ${q(feedId)} AND entries.guid IN (${list(candidates)})`,
    },
    ...created.map((e, i) => ({
      label: `create_entry.${i}`,
      sql: `INSERT INTO entries (id, feed_id, type, guid, url, title, author, content_original, content_cleaned,
  summary, content_hash, published_at, fetched_at, last_seen_at, is_backfill)
VALUES (${q(e.id)}, ${q(feedId)}, 'web', ${q(e.guid)}, ${q(e.guid)}, ${q(e.title)}, 'Author 1',
  ${q(`<article>${e.html}</article>`)}, ${q(e.html)}, ${q(e.summary)}, ${q(benchUuid(e.guid))},
  ${ts(fetchedAt)}, ${ts(fetchedAt)}, ${ts(fetchedAt)}, false)
RETURNING *`,
    })),
    {
      label: "previously_current",
      sql: `SELECT entries.guid FROM entries
WHERE entries.feed_id = ${q(feedId)} AND entries.last_seen_at >= ${ts(feed.last_entries_updated_at)}`,
    },
    {
      label: "update_last_seen",
      sql: `UPDATE entries SET last_seen_at = ${ts(fetchedAt)}
WHERE entries.id IN (${list(allIds)})
  AND (entries.last_seen_at IS NULL OR entries.last_seen_at < ${ts(fetchedAt)})`,
    },
    {
      label: "fanout",
      sql: `INSERT INTO user_entries (user_id, entry_id, published_or_fetched_at, subscription_id, is_spam, read)
SELECT s.user_id, e.id, COALESCE(e.published_at, e.fetched_at), s.id, e.is_spam, e.is_backfill
FROM subscriptions s
INNER JOIN entries e ON e.feed_id = s.feed_id
WHERE s.feed_id = ${q(feedId)}::uuid
  AND s.unsubscribed_at IS NULL
  AND e.id = ANY(${uuidArray(allIds)})
  AND NOT EXISTS (
    SELECT 1
    FROM user_entries ue_existing
    JOIN entries e_prev ON ue_existing.entry_id = e_prev.id
    WHERE ue_existing.user_id = s.user_id
      AND ue_existing.subscription_id = s.id
      AND e_prev.feed_id != s.feed_id
      AND regexp_replace(e_prev.guid, '^https?://', 'https://') = regexp_replace(e.guid, '^https?://', 'https://')
  )
ON CONFLICT DO NOTHING`,
    },
  ];
}

/** `markEntriesRead` / `updateEntriesStarred` UPDATE (services/entries.ts). */
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
    source: "services/entries.ts markEntriesRead (one entry, tagged feed)",
    prepare: async (db) => {
      const entry = await plainUnreadEntry(db);
      return {
        statements: [
          flagUpdateSql(U0, entry.id, "read"),
          {
            label: "readback",
            sql: `SELECT ve.id, ve.subscription_id, ve.read, ve.starred, ve.type, ve.updated_at, ve.read_changed_at
FROM visible_entries ve WHERE ve.user_id = ${q(U0)} AND ve.id IN (${q(entry.id)})`,
          },
          ...(await bulkCounts(db, U0, [{ id: entry.id, subscriptionId: entry.subscription_id }])),
        ],
      };
    },
  },
  {
    name: "write.mark_all_read_feed",
    kind: "write",
    source: "services/entries.ts markAllEntriesRead (subscription with 4,000 unread)",
    prepare: async (db) => {
      const filter = await entriesInSubscriptions(db, U0, [subA], UE_COLUMNS);
      const changedAt = ts(nowIso());
      const marked = await rows<{ id: string; subscription_id: string }>(
        db,
        `SELECT entry_id AS id, subscription_id FROM user_entries
WHERE user_id = ${q(U0)} AND subscription_id = ${q(subA)} AND NOT read AND NOT is_spam`
      );
      return {
        statements: [
          verifyOwnershipSql(U0, subA),
          filter.lookup,
          {
            label: "update",
            sql: `UPDATE user_entries SET read = true, read_changed_at = ${changedAt}, updated_at = ${changedAt}
WHERE user_entries.user_id = ${q(U0)} AND user_entries.read = false
  AND (user_entries.read_changed_at IS NULL OR user_entries.read_changed_at <= ${changedAt})
  AND user_entries.entry_id IN (
    SELECT ve.id FROM visible_entries ve WHERE ve.user_id = ${q(U0)} AND ve.is_spam = false)
  AND ${filter.condition}
RETURNING user_entries.entry_id, user_entries.subscription_id`,
          },
          ...(await bulkCounts(
            db,
            U0,
            marked.map((m) => ({ id: m.id, subscriptionId: m.subscription_id }))
          )),
        ],
      };
    },
  },
  {
    name: "write.star_one",
    kind: "write",
    source: "services/entries.ts updateEntriesStarred (one entry)",
    prepare: async (db) => {
      const entry = await plainUnreadEntry(db);
      return {
        statements: [
          flagUpdateSql(U0, entry.id, "starred"),
          // selectStarredEntryStates
          {
            label: "readback",
            sql: `SELECT user_entries.entry_id, user_entries.subscription_id, user_entries.read, user_entries.starred,
  entries.type, GREATEST(entries.updated_at, user_entries.updated_at), user_entries.read_changed_at
FROM user_entries INNER JOIN entries ON entries.id = user_entries.entry_id
WHERE user_entries.user_id = ${q(U0)} AND user_entries.entry_id IN (${q(entry.id)})`,
          },
          ...(await bulkCounts(db, U0, [{ id: entry.id, subscriptionId: entry.subscription_id }])),
        ],
      };
    },
  },
  {
    name: "write.subscribe_with_history",
    kind: "write",
    source:
      "services/subscriptions.ts createSubscription + populateInitialUserEntries (500 current entries)",
    prepare: async () => {
      const feedId = webFeedId(WEB.history);
      const url = webFeedUrl(WEB.history);
      const newSub = benchUuid("bench:new-subscription");
      const now = ts(nowIso());
      return {
        statements: [
          {
            label: "upsert_feed",
            sql: `INSERT INTO feeds (id, type, url, title, description, site_url, next_fetch_at, created_at, updated_at)
VALUES (${q(benchUuid("bench:new-feed"))}, 'web', ${q(url)}, NULL, NULL, NULL, ${now}, ${now}, ${now})
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
          {
            label: "upsert_subscription",
            sql: `INSERT INTO subscriptions (id, user_id, feed_id, subscribed_at, created_at, updated_at, fetch_full_content)
VALUES (${q(newSub)}, ${q(U0)}, ${q(feedId)}, ${now}, ${now}, ${now}, false)
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
    source: "services/subscriptions.ts unsubscribe (8,000-entry tagged feed)",
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
    source: "services/subscriptions.ts unsubscribe on a collection (40 members)",
    prepare: async (db) => ({ statements: await unsubscribeStatements(db, U0, readingList) }),
  },
  {
    name: "write.collection_delete_1000",
    kind: "write",
    source: "services/subscriptions.ts unsubscribe on a collection (1,000 members, added in setup)",
    prepare: async (db) => {
      const ids = await newestVisibleIds(db, 1000);
      return {
        setup: addToCollectionStatements(U0, emptyCollection, ids).map((s) => s.sql),
        statements: await unsubscribeStatements(db, U0, emptyCollection),
      };
    },
  },
  {
    name: "write.save_article",
    kind: "write",
    source:
      "services/saved.ts saveArticle: getOrCreateSavedFeed + selectExistingSavedRow + insertSavedEntry",
    prepare: async () => {
      const saved = savedFeedId(0);
      const url = "https://news.example.org/2026/10/05/a-new-article";
      const article = articleHtml(77, 12);
      const now = ts(nowIso());
      const entryId = benchUuid("bench:saved-entry");
      return {
        statements: [
          {
            label: "create_saved_feed",
            sql: `INSERT INTO feeds (id, type, user_id, title, url, email_sender_pattern, description, site_url, etag,
  last_modified_header, last_fetched_at, next_fetch_at, consecutive_failures, last_error, hub_url, self_url,
  websub_active, created_at, updated_at)
VALUES (${q(benchUuid("bench:saved-feed"))}, 'saved', ${q(U0)}, 'Saved Articles', NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, 0, NULL, NULL, NULL, false, ${now}, ${now})
ON CONFLICT DO NOTHING RETURNING feeds.id`,
          },
          {
            label: "select_saved_feed",
            sql: `SELECT feeds.id FROM feeds WHERE feeds.type = 'saved' AND feeds.user_id = ${q(U0)} LIMIT 1`,
          },
          {
            label: "existing",
            sql: `SELECT entries.*, user_entries.* FROM entries
INNER JOIN user_entries ON user_entries.entry_id = entries.id
WHERE entries.feed_id = ${q(saved)} AND entries.guid = ${q(url)} AND user_entries.user_id = ${q(U0)}
LIMIT 1`,
          },
          {
            label: "insert_entry",
            sql: `INSERT INTO entries (id, feed_id, type, guid, url, title, author, content_original, content_cleaned,
  summary, site_name, image_url, is_placeholder, published_at, fetched_at, content_hash, spam_score, is_spam,
  list_unsubscribe_mailto, list_unsubscribe_https, list_unsubscribe_post, created_at, updated_at)
VALUES (${q(entryId)}, ${q(saved)}, 'saved', ${q(url)}, ${q(url)}, ${q(article.title)}, 'A. Writer',
  ${q(`<html><body><article>${article.html}</article></body></html>`)}, ${q(article.html)}, ${q(article.summary)},
  'news.example.org', 'https://news.example.org/lead.jpg', false, NULL, ${now}, ${q(benchUuid(url))}, NULL, false,
  NULL, NULL, NULL, ${now}, ${now})
ON CONFLICT (feed_id, guid) DO NOTHING
RETURNING entries.id`,
          },
          {
            label: "insert_user_entry",
            sql: `INSERT INTO user_entries (user_id, entry_id, read, starred) VALUES (${q(U0)}, ${q(entryId)}, false, false)`,
          },
        ],
      };
    },
  },
  {
    name: "write.redirect_merge",
    kind: "write",
    source:
      "services/subscriptions.ts mergeSubscriptionIntoFeed (1,500-entry feed onto a fresh 300-entry feed)",
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
          {
            label: "lock_entries",
            sql: `SELECT user_entries.entry_id FROM user_entries
WHERE user_entries.user_id = ${q(U0)} AND user_entries.subscription_id = ${q(subMergeSource)}
ORDER BY user_entries.entry_id FOR NO KEY UPDATE`,
          },
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
            sql: `INSERT INTO subscriptions (id, user_id, feed_id, subscribed_at, created_at, updated_at, custom_title, fetch_full_content)
VALUES (${q(survivor)}, ${q(U0)}, ${q(newFeed)}, ${now}, ${now}, ${now}, ${q(old.custom_title)}, false)
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
            label: "restamp",
            sql: `UPDATE user_entries SET subscription_id = ${q(survivor)}
WHERE user_entries.user_id = ${q(U0)} AND user_entries.subscription_id = ${q(subMergeSource)}`,
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
];

export const BENCHMARKS: Benchmark[] = [...READS, ...WRITES];
