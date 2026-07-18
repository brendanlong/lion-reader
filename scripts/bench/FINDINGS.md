# SSR query benchmark — entries list & entry open

Benchmark of every Postgres query issued while server-rendering the authenticated
SPA (the layout prefetch set + the per-page prefetches). All of these are merged
into one SSR pass, so a single slow one shows up only as "the page is slow".

## How to reproduce

```bash
pnpm services                      # throwaway PG+Redis on random ports (background)
psql "$DATABASE_URL" -f scripts/bench/seed.sql      # ~30s, realistic dataset
psql "$DATABASE_URL" -f scripts/bench/bench.sql     # EXPLAIN (ANALYZE, BUFFERS)
```

`$DATABASE_URL` is in `.env.local-services` after `pnpm services`.

## Dataset (target user "U0")

Mid-size deployment; the target user is a heavy account (all SSR queries are
user-scoped, so the target user's row counts are what matter):

| table               | rows       | note                                  |
| ------------------- | ---------- | ------------------------------------- |
| entries             | 640,956    | 4,000 shared web feeds + a saved feed |
| user_entries        | 242,653    | 61 users total                        |
| subscriptions       | 1,800      |                                       |
| **U0** user_entries | **48,973** | across 300 subscriptions              |
| U0 unread           | 7,374      | ~15%                                  |
| U0 starred          | 1,457      | ~3%                                   |
| U0 tags             | 30         | ~70% of subs tagged                   |
| U0 saved            | 200        |                                       |

## What actually runs during SSR

Prefetches live in `src/app/(spa)/(app)/layout.tsx` (shared) and
`src/components/entries/EntryListPage.tsx` (per page).

Three "prefetches" issue **zero SQL** — they read only the already-loaded
session: `auth.me`, `users.me.preferences`, `summarization.isAvailable`.

The session itself is loaded once by the auth middleware and is **Redis-cached
(5-min TTL)**; on a cache miss it's a single unique-index lookup
(`sessions ⨝ users`), sub-ms.

## Results (warm cache, `EXPLAIN (ANALYZE, BUFFERS)`)

| Prefetch (surface)                     | Query                            | Time          | Buffers        | Plan / index                                                    |
| -------------------------------------- | -------------------------------- | ------------- | -------------- | --------------------------------------------------------------- |
| `sync.cursors` (layout, **awaited**)   | entries GREATEST(e,ue) argmax    | **125 ms** ⚠️ | **196,780** ⚠️ | seq of all 48,973 ue → PK nested loop into entries → top-N sort |
| `sync.cursors`                         | `MAX(subscriptions.updated_at)`  | 0.4 ms        | 55             | seq (300 subs)                                                  |
| `sync.cursors`                         | `MAX(tags.updated_at)`           | 0.2 ms        | 2              | `idx_tags_updated_at` (index-only)                              |
| `tags.list`                            | tags + feed_count + unread sum   | 1.3 ms        | 133            | seq(30 tags) + hash join                                        |
| `tags.list`                            | uncategorized feed count         | 0.3 ms        | 12             | `idx_subscriptions_user_active`                                 |
| `tags.list`                            | uncategorized unread sum         | 0.3 ms        | 12             | `idx_subscriptions_user_active`                                 |
| `entries.count` ×3 (all/saved/starred) | global counter arithmetic        | 0.5 ms ea     | 57             | counters on users+subscriptions (no entry scan)                 |
| `entries.list` `/all` p1               | timeline                         | 1.1 ms        | 51             | `idx_user_entries_published_or_fetched`                         |
| `entries.list` `/all` deep page        | keyset cursor (~page 20)         | 1.4 ms        | 1,803          | same index, seeks past cursor                                   |
| `entries.list` `/subscription`         | subscription timeline            | 0.9 ms        | 400            | index + subscription filter                                     |
| `entries.list` `/tag`                  | tagged-subs semijoin             | 0.4 ms        | ~200           | `idx_user_entries_published_or_fetched` + semijoin              |
| `entries.list` `/starred`              | unread starred                   | 0.7 ms        | —              | index                                                           |
| `entries.list` `/saved`                | saved articles                   | 1.1 ms        | —              | index                                                           |
| `entries.list` `/uncategorized`        | untagged-subs                    | 2.0 ms        | —              | index + anti-join (heaviest list)                               |
| `entries.list` `/recently-read`        | `sortBy=readChanged`             | 0.7 ms        | 114            | `idx_user_entries_read_changed_at`                              |
| `entries.get` (entry open)             | full entry via `visible_entries` | 0.6 ms        | 17             | PK lookups                                                      |
| `subscriptions.get` (sub pages)        | subscription + tags json_agg     | 0.7 ms        | 15             | PK lookups                                                      |

**Everything is correctly indexed and sub-2 ms — except one query.**
`sync.cursors`' entries arm is **125 ms and touches ~197k buffers (~1.5 GB)**,
and it is the one query the layout **`await`s**, so it sits directly on SSR TTFB.
Total DB time for the whole SSR pass is ~130 ms, of which ~125 ms is this single
query; everything else combined is under 8 ms.

> **Status:** fixed in `src/server/trpc/routers/sync.ts` (`sync.cursors`) — the
> entries argmax now uses the index-driven arms described below. Equivalence to
> the old query was verified across baseline / content-update-wins / tie /
> saved / starred-orphan cases; integration coverage added in
> `tests/integration/sync-events.test.ts` ("sync.cursors entries argmax").

## The problem: `sync.cursors` entries argmax

```sql
SELECT GREATEST(e.updated_at, ue.updated_at) AS max, e.id
FROM user_entries ue JOIN entries e ON e.id = ue.entry_id
WHERE ue.user_id = $userId
ORDER BY GREATEST(e.updated_at, ue.updated_at) DESC, e.id DESC
LIMIT 1;
```

`GREATEST(entries.updated_at, user_entries.updated_at)` spans two tables, so **no
index can serve the sort** — the planner must materialize the value for _every one
of the user's 48,973 entries_ (nested-loop PK lookup into `entries` for each) and
top-N sort the lot. The `LIMIT 1` gives no help. Cost grows with the user's entire
history, on every SSR and every SSE (re)connect.

This is the **same class of problem #1105 already fixed for the sibling
`sync.events` query** (see the long comment at `src/server/trpc/routers/sync.ts:271`):
that delta filter on the same `GREATEST(...)` was rewritten into an index-driven
UNION of arms (`user_entries.updated_at` via `idx_user_entries_updated_at`;
`entries.updated_at` per subscribed feed via `idx_entries_feed_updated_at`).
`sync.cursors` (the argmax) was left on the old shape.

### Fix (validated here)

The **maximum** of `GREATEST(a,b)` over a set is `GREATEST(max a, max b)` — a true
identity — so the value is derivable from two index-served maxes:

```sql
SELECT GREATEST(
  (SELECT max(ue.updated_at) FROM user_entries ue WHERE ue.user_id = $userId),
  (SELECT max(m.ts) FROM subscriptions s
     CROSS JOIN LATERAL (
       SELECT max(e.updated_at) AS ts FROM entries e WHERE e.feed_id = s.feed_id
     ) m
   WHERE s.user_id = $userId)
);
```

Measured: **1.3 ms, 1,117 buffers** — vs 125 ms / 196,780 buffers. All index-only
scans (`idx_user_entries_updated_at`, `idx_entries_feed_updated_at` per feed). A
**~100× buffer reduction.** (Add the saved-feed arm for parity with `sync.events`.)

The only extra work is `entriesAfterId` (the id tiebreaker for catch-up paging):

- Common case — the user's own activity is newest → the `user_entries` arm wins
  and the id falls out of that same index scan for free.
- Rare case — a content refetch bumped `entries.updated_at` past all user activity
  → resolve the id with one extra index seek (max id among the user's feed entries
  at that timestamp).

Recommend filing this and applying the #1105 pattern. It's the single highest-value
change on the SSR path (and it also speeds up the SSE-down polling fallback, which
re-establishes cursors on every reconnect).

## Does anything belong in Redis?

Mostly **no** — the fast queries are exactly the kind Postgres should serve, and
the things that _should_ be in Redis already are:

- **Session validation** — already Redis-cached (5-min TTL); Postgres only on miss.
- **Announcement banner / maintenance flag** — already Redis (`site-status.ts`),
  with an in-process few-second cache, deliberately DB-independent.
- **Unread badges** (`entries.count`, sidebar counts) — already denormalized onto
  trigger-maintained counter columns; 0.5 ms arithmetic, no entry scan. No win
  from Redis.
- **`entries.list` / `entries.get`** — index-served, sub-2 ms. Caching per-user
  timelines in Redis would add invalidation complexity (every read/star/mark/new
  entry) for no latency benefit.

The **one** legitimate Redis candidate is `sync.cursors` — but prefer the query fix
first (lower risk; the value is cheaply index-derivable as shown). If `sync.cursors`
later becomes hot, a per-user "latest cursor" key maintained by the pubsub
publishers (which already run on every read/star/mark-all/new-entry/content-update)
would make it O(1). That's an optimization to reach for only after the query fix,
since a cache-consistency bug here would corrupt delta sync.

## Note on this benchmark's seed

`entries.updated_at` is seeded uniformly (`now()`), which does **not** affect the
125 ms finding (that query's cost is the per-row `GREATEST` + heap fetch, not the
tiebreaker sort). It does make an id-carrying variant of the fix look slower than
it is in production (where `updated_at` varies per entry), which is why the
validated fix above measures the **value** — the id resolution is cheap/rare as
described.
