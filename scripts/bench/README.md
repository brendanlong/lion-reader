# Database benchmarks

The SQL behind the hot paths (server-rendered lists, sync, search, the Google
Reader API, fan-out, marking read, subscriptions, collections, saving), run
against a production-shaped dataset. **Every PR that changes a hot path's
queries, triggers, indexes or schema reports before/after numbers from this
suite** (#1846). Slowdowns are acceptable when they're measured and explained.

- `seed.ts` builds the dataset: production's row counts as of 2026-10-05 and
  its heaviest libraries. Its header says how the text is generated.
- `benchmarks.ts` holds the benchmarks. Each reproduces the statements one
  service function sends and cites it; **change a benchmark together with the
  function it mirrors**, keeping its name so comparisons line up.
- `run.ts` runs them and says how (EXPLAIN ANALYZE, rolled-back writes,
  warm-up, vacuuming between iterations); `compare.ts` diffs two runs.
- `baseline.json` is the phase 0 run of #1846, for seeing which benchmarks
  are heavy and how they plan, not the "before" of a comparison.

## Running

```bash
pnpm services          # as a background task: throwaway Postgres + Redis
pnpm bench:db:seed     # ~3 minutes; refuses to wipe a database that isn't a benchmark one
pnpm bench:db          # ~3 minutes; prints a table, writes scripts/bench/results/<time>-<sha>.json
```

The scripts use the `DATABASE_URL` in `.env.local-services`. `pnpm bench:db`
takes `--iterations` (default 5), `--warmup` (default 5), `--filter name,name`
(substring match), `--out file.json` and `--note text`.

Columns: **ms** is planning + execution summed over the benchmark's
statements, triggers included (median; **max** over the iterations).
**trigger ms** is the part spent in triggers, foreign-key checks included.
**buffers** are shared buffers hit or read by everything the statements ran,
triggers included, counted with pg_stat_statements, which `pnpm services`
loads. Against a server without it they fall back to the plans' own buffers,
which miss trigger work entirely (an unsubscribe shows a few dozen), and
`compare` says so. **WAL** includes trigger writes. **rows** are rows
returned, or for writes rows written by the statements themselves. **access**
lists the indexes and sequentially scanned tables the plans used.

### Warm and cold

**ms** and **buffers** are the warm state: a connection that has already run
the benchmark five times. PL/pgSQL plans a statement for its arguments for its
first five executions in a session and may then switch to a generic plan,
which is what the triggers run on production's long-lived pooled connections.
Writes also report **cold ms**: each iteration on a new connection, so the
triggers still plan per call, plus the cost of filling the connection's
catalog caches. The warm-up calls are all for U0, the heaviest library, and
that is what tips the switch: Postgres picks the generic plan when it looks no
costlier than the custom plans so far, and U0's look costly. A connection
whose first calls are for light users keeps custom plans. So warm is the worst
case a production connection can settle into, and cold the best. A change
that alters which plan the triggers settle on shows up as warm and cold moving
differently. A warm time several times the cold one points at a slow generic
plan (#1862).

## Comparing before and after

Absolute numbers depend on the machine and Postgres settings, so only compare
two runs from **the same machine, in one session, against the same seed**:

```bash
git switch master && pnpm bench:db:seed && pnpm bench:db --out /tmp/before.json
git switch my-branch
pnpm bench:db:migrate      # only if the branch has migrations
pnpm bench:db --out /tmp/after.json
pnpm bench:db:compare /tmp/before.json /tmp/after.json   # markdown for the PR description
```

Migrations aren't reversible, so re-seed on master before running master
again. A run ANALYZEs any table a migration left without fresh statistics
(listed in the result's `meta.analyzed`). `compare` warns when the two runs
differ in machine, Postgres or row counts.

Read buffer ratios first: on an unchanged tree they repeat within 1%, except
the parallel plans (`ssr.list_saved`, `greader.stream_saved`, about ±10%).
For trigger-heavy writes, read buffers together with trigger ms, WAL and cold
ms, since that's where those writes spend their time. Times repeat within
about 10% on an idle machine, but a busy one moves them all together, and
sub-millisecond ratios are noise. A "changed" plan means the set of indexes or
sequential scans moved; the statements' `nodes` in the two result files show
how.

## Does anything belong in Redis?

Mostly no. Sessions (5-minute TTL) and the site-status flags are already in
Redis; every unread badge is a trigger-maintained counter read in well under a
millisecond (`ssr.entries_count`, `ssr.tags_list`); timeline pages and entry
reads are index-served in about a millisecond (`ssr.list_*`, `ssr.entries_get`).
Caching per-user timelines would add invalidation on every read, star and new
entry for no latency win.
