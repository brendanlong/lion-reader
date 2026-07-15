# Runbook: Migrate from Managed Postgres (MPG) to unmanaged Fly Postgres

**Written 2026-07-14.** Moves production from the Fly Managed Postgres "Basic" plan
(cluster `k1v53olme1nr8q6p`, `lion-reader-db`, ~$41/mo, shared-cpu-2x/1GB, 2-node HA)
to a **single-node unmanaged Fly Postgres (flex)** on `shared-cpu-8x` / 4GB
(~$28/mo incl. volume).

**Why this shape:** Fly shared-CPU quotas are pooled per machine (5ms × vCPUs per
80ms period — [CPU performance docs](https://fly.io/docs/machines/cpu-performance/)),
so shared-8x gives Postgres a 50%-of-a-core sustained floor (vs 12.5% on MPG Basic),
burst to 8 cores while the 500 CPU-second burst balance lasts, and 4× the RAM for
cache — at ~70% of the MPG price. Single node is deliberate: flex multi-node uses
repmgr, which has a poor failure-mode track record; WAL backups + volume snapshots
are the safety net instead. Trade-offs: no Fly support for unmanaged Postgres, we
own upgrades, and a host failure means restoring from backup instead of failover.

**Downtime:** the app is stopped during the dump/restore — minutes for a <10GB DB.

**Prerequisites:** local `flyctl` authenticated with full org access (deploy tokens
can't open the WireGuard tunnels that `fly mpg proxy` / `fly proxy` need), and local
Postgres client tools (`pg_dump`/`psql`) at a major version ≥ the server's.

---

## 1. Pre-flight

```bash
# Current state / the MPG cluster id
fly mpg list -o personal
fly machine list -a lion-reader

# Grab the current MPG connection string (this is also the rollback value)
fly ssh console -a lion-reader --machine <app-machine-id> -C "printenv DATABASE_URL"
# Save it somewhere safe. Note the user, password, and database name.

# Safety backup on the MPG side
fly mpg backup create k1v53olme1nr8q6p

# Check the source Postgres major version (pg_dump client must be >= this)
fly mpg proxy k1v53olme1nr8q6p --local-port 16543 &
psql "<MPG url with host replaced by 127.0.0.1:16543>" -c "select version()"
```

## 2. Create the new cluster

```bash
fly postgres create \
  --name lion-reader-pg \
  --org personal \
  --region lax \
  --flex \
  --initial-cluster-size 1 \
  --vm-size shared-cpu-8x \
  --vm-memory 4096 \
  --volume-size 10 \
  --enable-backups
```

- `--enable-backups` provisions a Tigris bucket and turns on WAL-based backups
  (real PITR; restore with `fly postgres backup restore`).
- **Save the superuser password it prints** — it is shown once.
- Sanity-check the memory-derived tuning; flex sizes `shared_buffers` etc. from VM
  memory at init:

```bash
fly postgres config view -a lion-reader-pg
# If shared_buffers looks sized for 2GB rather than 4GB:
# fly postgres config update -a lion-reader-pg --shared-buffers 1024MB
```

Optional rehearsal (no downtime): run the §4 dump/restore now against the live DB
just to time it, then drop/recreate the target database before the real cutover.
The worker writes continuously, so a rehearsal copy is _not_ a valid final copy.

## 3. Cutover — stop the app (downtime starts)

```bash
fly machine list -a lion-reader   # note the app, worker, and discord machine ids
fly machine stop <app-id> <worker-id> <discord-id> -a lion-reader

# attach (next step) fails if DATABASE_URL already exists; machines are stopped,
# so --stage avoids any deploy/restart churn
fly secrets unset DATABASE_URL -a lion-reader --stage
```

## 4. Provision the app user and copy the data

```bash
# Creates role + database on the new cluster and sets DATABASE_URL on the app.
# SAVE the connection string it prints (password is shown once).
fly postgres attach lion-reader-pg -a lion-reader --database-name lion_reader

# Two tunnels: old MPG on 16543 (may still be running from §1), new flex on 16544
fly mpg proxy k1v53olme1nr8q6p --local-port 16543 &
fly proxy 16544:5432 -a lion-reader-pg &

# Copy. Use the creds from the MPG URL (§1) on the left, and the user/password/db
# from the attach output on the right — only the hosts are replaced.
pg_dump "postgres://<mpg-user>:<mpg-pass>@127.0.0.1:16543/<mpg-db>" \
    --no-owner --no-privileges \
  | psql "postgres://lion_reader:<attach-pass>@127.0.0.1:16544/lion_reader" \
    -v ON_ERROR_STOP=1 --single-transaction
```

Notes:

- `--no-owner --no-privileges` because the source roles don't exist on the target;
  objects end up owned by the connecting `lion_reader` user, which is what the app
  uses. The dump includes `CREATE EXTENSION citext` (the attach user is superuser
  by default, so this succeeds).
- The drizzle migration bookkeeping is part of the dump, so the next deploy's
  `release_command` migration run is a no-op.

Spot-check row counts on both sides before proceeding:

```bash
for url in "postgres://...16543/<mpg-db>" "postgres://...16544/lion_reader"; do
  psql "$url" -c "select (select count(*) from entries) as entries,
                         (select count(*) from subscriptions) as subs,
                         (select count(*) from users) as users"
done
```

## 5. Restart and verify (downtime ends)

```bash
fly machine start <app-id> <worker-id> <discord-id> -a lion-reader

curl -s https://lionreader.com/api/health   # expect database + redis healthy
fly logs -a lion-reader --no-tail | tail -50
```

Then check the UI: entries load, mark-read works, new entries appear (worker is
fetching), Discord bot responds.

## Rollback

The MPG cluster is untouched until §6. To roll back:

```bash
fly secrets set DATABASE_URL="<original MPG url from §1>" -a lion-reader
fly machine restart <app-id> <worker-id> <discord-id> -a lion-reader
```

Any writes made to the new cluster after cutover are lost on rollback (acceptable
for a short observation window; entries re-fetch from feeds).

## 6. Post-cutover (after a few days of confidence)

```bash
# Verify backups are flowing
fly postgres backup list -a lion-reader-pg
fly volumes list -a lion-reader-pg   # daily snapshots, default 5-day retention

# Take a final local archive of the old DB, then destroy MPG (ends the $38/mo plan)
pg_dump "<MPG url via proxy>" -Fc -f lion-reader-mpg-final.dump
fly mpg destroy k1v53olme1nr8q6p
```

Also restore the second app machine (drift found 2026-07-14: only one `app` machine
was running despite `min_machines_running = 2`, which breaks zero-downtime canary
deploys):

```bash
fly scale count app=2 -a lion-reader
```

## Ongoing operations you now own

- **Watch throttling:** on [fly-metrics.net](https://fly-metrics.net), the
  `lion-reader-pg` app's CPU dashboard shows the burst balance
  (`fly_instance_cpu_balance`) and throttle/steal time. If the balance pins at 0
  outside of backups, upgrade: `fly machine update <id> --vm-size performance-1x -a
lion-reader-pg` (dedicated core, ~$32/mo, seconds of restart).
- **Minor version updates:** `fly image update -a lion-reader-pg` (restarts the node).
- **Major version upgrades:** dump/restore into a fresh cluster (repeat this runbook
  shape) — Fly does not upgrade unmanaged clusters.
- **Disk:** 10GB volume; `fly volumes extend` when needed. A full volume is an
  outage you have to notice — check the fly-metrics disk panel occasionally.
- **Restore drill:** once, soon after migrating, run `fly postgres backup restore`
  into a scratch cluster to prove the WAL backups actually restore.
