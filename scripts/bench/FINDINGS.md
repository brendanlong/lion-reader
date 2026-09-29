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
