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

**Fixed:** `sync.cursors` (`src/server/trpc/routers/sync.ts`, whose comment
explains the index-driven arms) now measures **1.3 ms / 1,117 buffers** vs 125 ms /
196,780 — a ~100× buffer reduction.

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

The **one** legitimate Redis candidate is `sync.cursors`. If it becomes hot
despite the query fix, a per-user "latest cursor" key maintained by the pubsub
publishers (which already run on every read/star/mark-all/new-entry/content-update)
would make it O(1) — at the risk that a cache-consistency bug corrupts delta sync.
