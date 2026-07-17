# Fly `performance-2x/4GB` capacity test — runbook

Runs the same benchmark as the local test against a **throwaway** Fly app on the
cheapest dedicated-CPU tier you wanted to check (`performance-2x`, 2 dedicated
cores, 4 GB). Tear it all down at the end.

> **Why a runbook and not an automated script:** the agent that built this only
> had an app-scoped Fly _deploy token_ — it can't create apps, tunnel, or SSH, so
> it couldn't run or test this end-to-end. Run it yourself (you have full perms),
> or hand the agent a broader token and it'll drive it. Review each step; this
> creates real (cheap, short-lived) billable resources.
>
> **The local 2-core run is already a good proxy** for this tier (see
> `~/wiki/pages/lion-reader-capacity-benchmark-2026.md`): ~250 concurrent active
> users / ~350 rps, DB never the bottleneck. This run confirms it on real Fly
> hardware and network.

Everything below assumes you're in the repo root with `flyctl` authenticated.

## 1. Create the throwaway app + datastores

```bash
fly apps create lion-reader-bench --org personal

# Postgres — single node, dedicated CPU so the DB isn't the variable under test.
fly postgres create --name lion-reader-bench-db --org personal \
  --region lax --vm-size performance-1x --volume-size 10 --initial-cluster-size 1
fly postgres attach lion-reader-bench-db -a lion-reader-bench   # sets DATABASE_URL

# Redis (Upstash via Fly). Copy the redis:// URL it prints.
fly redis create --name lion-reader-bench-redis --org personal --region lax
fly secrets set -a lion-reader-bench REDIS_URL="redis://…"
```

The app needs **only** `DATABASE_URL` + `REDIS_URL` at boot (storage/OAuth secrets
are lazy and unused by the load test).

## 2. Deploy the CURRENT image on performance-2x

Build the image once and deploy it with the benchmark config:

```bash
# Build & push the app image (or reuse a recent prod image tag).
fly deploy -a lion-reader-bench --config bench/fly-bench/fly.bench.toml \
  --build-only --push --image-label bench-$(date +%s)
# ^ note the image ref it prints, then:
fly deploy -a lion-reader-bench --config bench/fly-bench/fly.bench.toml \
  --image registry.fly.io/lion-reader-bench:bench-…
```

(Or simply `fly deploy -a lion-reader-bench --config bench/fly-bench/fly.bench.toml`
to build from the Dockerfile. `release_command` runs migrations.)

Confirm one `performance-2x` app machine is up: `fly status -a lion-reader-bench`.

## 3. Seed the throwaway DB

Open a proxy to the bench Postgres and run the seeder against it from your box:

```bash
fly proxy 15432:5432 -a lion-reader-bench-db &       # local :15432 → bench DB
# DATABASE_URL from `fly postgres attach` output, host swapped to 127.0.0.1:15432
USERS=1000 DATABASE_URL="postgres://…@127.0.0.1:15432/lion_reader_bench" \
  npx tsx bench/seed-bench.ts
```

This writes `bench/sessions.json` (1000 live sessions) — same as local.

## 4. Run the load test from your box against the Fly app

Scrape server-side metrics through a second proxy (Fly's internal metrics port
isn't public):

```bash
fly proxy 9091:9091 -a lion-reader-bench &           # server-side metrics
BASE_URL=https://lion-reader-bench.fly.dev \
  METRICS_URL=http://127.0.0.1:9091/metrics \
  STAGES=25,50,100,150,200,300 STAGE_SECONDS=45 RESULT_LABEL=fly-perf2x \
  npx tsx bench/loadtest.ts
```

Also watch Fly's own CPU signal during the run (dedicated cores shouldn't
throttle, but confirm): `fly_instance_cpu_balance` in `fly dashboard metrics`, and
`fly logs -a lion-reader-bench`.

> Network note: the driver runs on your box, so client-side latency includes
> WAN RTT to `lax`. Trust the **server-side** `list.mean` / `markRead.mean` from
> the metrics scrape for the capacity knee (same as the local method).

## 5. Compare & tear down

Compare `bench/results-fly-perf2x.json` `knee` to the local 2-core run. Then:

```bash
kill %1 %2 2>/dev/null                                # close proxies
fly apps destroy lion-reader-bench --yes
fly postgres detach lion-reader-bench-db -a lion-reader-bench 2>/dev/null || true
fly apps destroy lion-reader-bench-db --yes
fly redis destroy lion-reader-bench-redis --yes 2>/dev/null || true
```

## Optional: measure the CURRENT shared-cpu tier (the real HN risk)

To see the throttling collapse directly, repeat with `size = "shared-cpu-2x"` /
`memory = "512mb"` in `fly.bench.toml`. Expect the burst balance to carry the
first ~seconds, then server-side latency to blow up as it hard-caps at the
6.25 %-per-vCPU baseline — the failure mode a HN spike would hit today. See
`~/wiki/pages/lion-reader-hosting-options-2026.md`.
