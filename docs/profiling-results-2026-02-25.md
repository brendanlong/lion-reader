# /all Endpoint Profiling Results

**Date:** 2026-02-25
**Environment:** Production mode (`NODE_ENV=production`), `next start`
**Database:** 1,101 entries, 53 subscriptions, 2 tags, 1 user (local Postgres)

## Summary

The `/all` page SSR TTFB is **~15ms (p50)** at this data scale. The server is
**I/O bound** (waiting on Postgres), not CPU bound. The first request after a
cold start is ~500ms due to lazy module loading, but steady-state is fast.

### Critical Path for `/all` TTFB

```
Request arrives
  |
  ├── Next.js routing & middleware              ~1ms
  |
  ├── Session validation                        ~0.02ms (Redis cache hit)
  |     └── Redis lookup + Postgres fallback
  |
  ├── Parallel tRPC prefetches (in-process)     ~6ms (bounded by slowest)
  |     ├── entries.list (limit 20)             ~3.6ms (1.8ms plan + 1.8ms exec)
  |     ├── tags.list                           ~3.0ms (1.6ms plan + 0.3ms exec + 2.0ms uncategorized)
  |     ├── entries.count {}                    ~0.9ms (0.3ms plan + 0.5ms exec)
  |     ├── entries.count {saved}               ~0.9ms
  |     ├── entries.count {starred}             ~0.9ms
  |     ├── sync.cursors                        ~0.9ms (3 MAX queries)
  |     ├── entries.hasScoredEntries            ~0.5ms
  |     ├── summarization.isAvailable           ~0.1ms (no DB)
  |     ├── auth.me                             ~0.0ms (from session)
  |     └── users.me.preferences                ~0.5ms
  |
  ├── React SSR rendering                       ~5-8ms
  |     └── Component tree → HTML stream
  |
  └── First byte written to socket

Total TTFB: ~15ms (p50), ~18ms (p95)
```

## Endpoint Latencies (p50 TTFB via HTTP)

| Endpoint                    | p50 TTFB | p95 TTFB | Response Size |
| --------------------------- | -------- | -------- | ------------- |
| `/all` (SSR full page)      | 15.0ms   | 18.0ms   | 67KB          |
| `entries.list` (limit 20)   | 6.2ms    | 7.5ms    | 16KB          |
| `subscriptions.list`        | 5.3ms    | 6.9ms    | 16KB          |
| `tags.list`                 | 4.8ms    | 6.8ms    | 466B          |
| `entries.count` (all)       | 3.4ms    | 4.6ms    | 57B           |
| `entries.count` (saved)     | 3.3ms    | 4.7ms    | 51B           |
| `sync.cursors`              | 2.9ms    | 4.4ms    | 153B          |
| `entries.count` (starred)   | 2.8ms    | 3.7ms    | 51B           |
| `entries.hasScoredEntries`  | 2.3ms    | 3.7ms    | 55B           |
| `auth.me`                   | 2.2ms    | 3.7ms    | 282B          |
| `summarization.isAvailable` | 1.8ms    | 3.4ms    | 48B           |
| Health (baseline)           | 1.6ms    | 2.2ms    | 159B          |

**Note:** HTTP overhead is ~1.6ms (health baseline). In-process tRPC calls
during SSR skip HTTP entirely, so the actual SSR prefetch cost is lower.

## SQL Query Performance (EXPLAIN ANALYZE)

| Query                                    | Plan Time | Exec Time | Buffer Hits | Notes                                          |
| ---------------------------------------- | --------- | --------- | ----------- | ---------------------------------------------- |
| `entries.list` (visible_entries + feeds) | 1.84ms    | 1.77ms    | 68          | 5 joins, seq scans (small tables)              |
| `tags.list` (tag counts)                 | 1.62ms    | 0.29ms    | 140         | Correlated subqueries, index scans             |
| `tags.list` (uncategorized)              | 1.30ms    | 2.00ms    | 3,551       | NOT EXISTS, 3 LEFT JOINs, **most buffer hits** |
| `entries.count`                          | 0.33ms    | 0.73ms    | 60          | visible_entries view aggregate                 |
| `subscriptions.list`                     | 0.68ms    | 0.85ms    | 66          | CTE + 3 LEFT JOINs + GROUP BY                  |
| `sync.cursors` (entries)                 | 0.11ms    | 0.53ms    | 57          | MAX over user_entries JOIN entries             |
| Session validation                       | 0.25ms    | 0.02ms    | 3           | Index lookup, cached in Redis                  |

### Key observations

1. **Planning time dominates for complex queries.** The `entries.list` query
   spends 1.84ms planning and only 1.77ms executing. At this data scale, the
   planner overhead is nearly 50% of total query time.

2. **Uncategorized count is the costliest query.** The `tags.list` uncategorized
   count query touches 3,551 buffer pages -- 50x more than any other query --
   due to the `NOT EXISTS` subquery with 3 LEFT JOINs scanning through all
   entries for uncategorized subscriptions.

3. **All tables use sequential scans.** At 1,101 entries/53 feeds, Postgres
   correctly chooses seq scans over index scans. Indexes will become important
   at ~10K+ entries.

4. **`visible_entries` view has 4 implicit joins.** Every query through this
   view pays the cost of joining `user_entries`, `entries`, `subscription_feeds`,
   `subscriptions`, and `entry_score_predictions`.

## CPU Profile Analysis

| Category                     | Time   | % of Non-Idle |
| ---------------------------- | ------ | ------------- |
| Module loading (CJS require) | 663ms  | 19.8%         |
| Next.js framework            | 347ms  | 10.4%         |
| React SSR rendering          | ~200ms | 6.0%          |
| Async hooks overhead         | 45ms   | 1.3%          |
| pg (Postgres driver)         | 40ms   | 1.2%          |
| GC                           | 238ms  | 7.1%          |

Module loading is a one-time cost (cold start). After warmup, the CPU profile
shows the server spending most time in I/O wait (waiting for Postgres responses).

## Scaling Concerns

At the current scale (1,101 entries), everything is fast. Based on the query
patterns and existing perf test documentation, the likely scaling bottlenecks at
10K-50K entries are:

1. **Uncategorized unread count** (`tags.list`): The `NOT EXISTS` + 3 LEFT JOINs
   pattern scans all entries for all uncategorized subscriptions. Already the
   most expensive query at 1.1K entries. At 50K entries, this could be
   500ms+ without optimization.

2. **`visible_entries` view** joins: The 4-way join in the view is materialized
   for every query. At scale, the `entry_score_predictions` LEFT JOIN and
   `subscription_feeds` LEFT JOIN will become costly.

3. **`entries.list` sort**: The `ORDER BY COALESCE(published_at, fetched_at)
DESC` requires a full sort of the visible entries. An index on
   `(user_id, COALESCE(published_at, fetched_at) DESC)` on a materialized
   view could help, but the COALESCE makes standard indexes less effective.

4. **Planning time**: At this scale, query planning is ~50% of execution time.
   Prepared statements could help by caching plans across requests.

5. **Parallel prefetch contention**: The SSR layout fires 8+ prefetches in
   parallel. These all share a single pg connection pool. Under load with
   multiple concurrent users, connection pool contention could serialize
   these queries.

## Cold Start Impact

| Request            | TTFB  |
| ------------------ | ----- |
| 1st request (cold) | 511ms |
| 2nd request        | 26ms  |
| 3rd request        | 21ms  |
| Steady state (p50) | 15ms  |

The first request triggers lazy loading of server modules (jsdom, pg, drizzle,
etc.) -- ~500ms of CJS require() overhead. This is a one-time cost per server
process start.

## What Doesn't Matter (at this scale)

- **React SSR rendering**: ~5-8ms, fast enough
- **Session validation**: Cached in Redis, <1ms
- **tRPC overhead**: Negligible for in-process calls
- **Compression**: Disabled for profiling, would add ~1-2ms for gzip
- **Network**: Localhost testing eliminates network latency

## Recommendations for Future Optimization

1. **Optimize uncategorized count query** -- Consider a materialized count or
   denormalized counter column instead of the expensive NOT EXISTS + multi-join
   pattern.

2. **Consider prepared statements** -- Would eliminate the ~1-2ms planning
   overhead per query, potentially saving ~5ms per SSR request when multiple
   queries run.

3. **Monitor `visible_entries` view performance** as entry count grows --
   The 4-way join will become the main bottleneck. A materialized view with
   periodic refresh, or denormalized columns, could help.

4. **Profile at production data scale** -- This profiling was done with 1.1K
   entries. Results at 10K-50K entries will look very different, especially
   for the count queries and sort operations.

5. **Cold start mitigation** -- The 500ms first-request penalty comes from
   lazy module loading. Eager-loading critical modules during server startup
   (before accepting requests) would eliminate this.
