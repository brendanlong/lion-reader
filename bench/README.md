# Lion Reader capacity benchmark

Estimates how many users Lion Reader can support on a given machine by replaying
a realistic logged-in-user workload against a running app and ramping
concurrency until it saturates.

## Why this exists

Before posting to a big-traffic site (e.g. Hacker News) we want to know the
registered-user ceiling per hardware tier, and how a traffic spike behaves given
Fly's shared-CPU burst-balance throttling. See
`~/wiki/pages/lion-reader-capacity-benchmark-2026.md` for results and method
notes.

## Pieces

| File                    | Role                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `characterize-prod.sql` | Read-only prod aggregates → the real per-user parameters. Run it, save output, drop numbers into `prod-params.json`.                           |
| `config.ts`             | Workload parameters (seed shape, session behaviour, capacity translation). Defaults are estimates; `prod-params.json` overrides them.          |
| `seed-bench.ts`         | Populates a DB with N synthetic users matching the prod distribution + one live session each → `sessions.json`.                                |
| `loadtest.ts`           | The driver: ramps VUs through a staircase, replays the real request mix, finds the capacity knee, scrapes the server's own Prometheus metrics. |
| `lib/trpc-client.ts`    | Per-VU tRPC client using the app's own superjson transformer (wire-identical to prod) over a large undici pool.                                |

## What "one user" does per session

Page-load bundle (`entries.list` + `subscriptions.list` + `tags.list` + 3×
`entries.count`, fired together) → scroll a couple more list pages → open N
articles (`entries.get` + single `entries.markRead`) with human think-time →
occasional star / batch mark-read → rare mark-all-read. Each VU also holds one
SSE connection (`/api/v1/events`) open, like the browser. Weights/counts live in
`config.ts` `session`.

## Reading the results — trust server-side, not client-side

The driver is a **single Node process**. Above a few hundred VUs on a big host,
decoding list responses saturates _its_ event loop and inflates _client-side_
latency before the server is actually stressed. So the knee gates on
**server-side** signals — the app's own `trpc_procedure_duration_seconds`
histogram and the `db_pool_waiting_requests` gauge — and the summary says
whether a failing stage was the **server saturating** (pool queued / server
latency climbed) or merely **generator-bound** (server still flat). To push a
big host past the generator cap, run the driver from a second machine (or
multiple processes).

## Capacity translation

The load test yields a _concurrent-active-user_ knee. We report a
_registered-user_ ceiling via
`registered = knee / peakConcurrentFraction`, where `peakConcurrentFraction`
comes from prod recency data (`characterize-prod.sql` §2: active-in-5min vs
total registered, adjusted for a peak factor). Until real numbers land it
defaults to 5%.

## Run it

```bash
# 0. one-time: build native + app
pnpm build:native && pnpm build:all      # (or: pnpm build && pnpm build:server && pnpm build:worker)

# 1. local throwaway DB + Redis (leave running in the background)
pnpm services

# 2. start the prod app against the local DB, metrics on :9091
PORT=39547 NODE_ENV=production METRICS_ENABLED=true \
  npx dotenv -e .env.local-services -- node dist/server.js &
PORT=39547 NODE_ENV=production METRICS_ENABLED=true WORKER_CONCURRENCY=1 \
  npx dotenv -e .env.local-services -- node dist/worker.js &

# 3. seed synthetic users (writes bench/sessions.json)
USERS=1000 npx dotenv -e .env.local-services -- npx tsx bench/seed-bench.ts

# 4. ramp
BASE_URL=http://127.0.0.1:39547 METRICS_URL=http://127.0.0.1:9091/metrics \
  STAGES=25,50,100,200,400,800 STAGE_SECONDS=45 RESULT_LABEL=local \
  npx tsx bench/loadtest.ts
```

For the Fly test, point `BASE_URL` at the throwaway Fly app and `METRICS_URL` at
its metrics endpoint (or omit metrics and rely on client error-rate + `flyctl`
CPU-balance observation). See the wiki page.

### Env knobs

`USERS`, `STAGES` (comma list of VU counts), `STAGE_SECONDS`, `WARMUP_SECONDS`,
`BASE_URL`, `METRICS_URL`, `RESULT_LABEL`, `MAX_CONNECTIONS`, `PG_POOL_MAX`
(server side).

## Worker (feed-fetch) throughput — `bench/worker/`

Answers "how many feeds can one worker keep polled before it falls behind?"
Separate from the request-path benchmark above. Seeds M feeds (each with an
active subscriber) all due now, pointed at a local mock feed server, then runs
the real `dist/worker.js` and times how fast it drains the backlog — for a sweep
of `WORKER_CONCURRENCY`, in two phases:

- **FRESH** — first poll returns 200 + N items → full parse + entry processing +
  sanitize + `user_entries` fanout (worst case: cold start / mass subscribe /
  every feed updated at once).
- **NOT-MODIFIED** — re-poll after the worker stored our ETag → 304 (steady
  state: most real polls find nothing new).

Runs against the **test** DB (`lionreader_test`) so it doesn't touch the capacity
seed, and spawns the worker with `ALLOW_PRIVATE_NETWORK_FETCH=true` so it can
reach `127.0.0.1`.

```bash
# realistic network latency (the number that matters — the worker is I/O-bound):
FEEDS=500 CONCURRENCIES=1,3,8,16 ITEMS_PER_FEED=25 MOCK_LATENCY_MS=150 \
  npx dotenv -e .env.local-services.test -- npx tsx bench/worker/worker-bench.ts

# CPU/DB ceiling (0ms latency, more feeds to get a stable rate):
FEEDS=2000 CONCURRENCIES=1,3,8,16 ITEMS_PER_FEED=25 MOCK_LATENCY_MS=0 \
  npx dotenv -e .env.local-services.test -- npx tsx bench/worker/worker-bench.ts
```

Output per concurrency: feeds/s for FRESH and 304, and the implied feed count
sustainable at hourly cadence. Set `MOCK_LATENCY_MS` to model real feed-server
RTT — at `concurrency=1` throughput is ~`1/latency` (serial), so this dominates.
Knobs: `FEEDS`, `CONCURRENCIES`, `ITEMS_PER_FEED`, `MOCK_LATENCY_MS`.

> Caveat: the mock uses a uniform latency, so it does **not** model the slow-feed
> tail. With `WORKER_CONCURRENCY=1`, a single feed that hangs to the 30 s fetch
> timeout blocks the only slot for 30 s (head-of-line blocking) — the strongest
> reason to raise concurrency is latency isolation, not raw throughput.
