# Fly.io Postgres (Flex) — Operations, Gotchas & Recovery

Our database is an **unmanaged Fly Postgres Flex** cluster (`lion-reader-pg`, image
`flyio/postgres-flex`). "Unmanaged" means **we** own operations, backups, and disaster
recovery — Fly support does not. This doc is the runbook for the failure modes that
actually bit us and how to avoid / recover from them.

> **Golden rule:** before _any_ destructive Postgres operation (destroying a machine,
> failover, region move), **take a volume snapshot first**:
> `fly volumes snapshots create <volume-id>`. Snapshots are cheap, retained
> independently of the volume, and are your only undo button.

Related: [DEPLOYMENT.md](DEPLOYMENT.md). Continuous WAL archiving / PITR is **enabled**
(issue #1376) — see [Backups & Point-in-Time Recovery (PITR)](#backups--point-in-time-recovery-pitr).

---

## Mental model

- The **app connects to `<pg-app>.internal` / Flycast**, which routes writes to whatever
  node is currently the **primary**. So promoting a new primary is transparent to the app
  (the `DATABASE_URL` doesn't change) — _if_ it's done cleanly.
- **Roles are dynamic**, decided at runtime by **repmgr**, not baked into machine config.
  Both `fly machines list` (`ROLE` column) and the `role` health check can be **stale** by
  a few minutes — never trust them during an incident.
- The **authoritative** role of a node is the SQL answer `select pg_is_in_recovery();`
  (`f` = primary/writable, `t` = read-only standby), and the authoritative topology is
  `repmgr -f /data/repmgr.conf cluster show`.
- Volumes are **region-pinned and cannot be moved between regions.** Getting data into a
  new region means either streaming replication or a snapshot/dump copy — never a "move".

## Quorum: 2 nodes is a trap

Automatic failover (`fly pg failover`) uses a **quorum** (strict majority) to avoid
split-brain. Consequences:

- **1 node:** fine, but no HA. Single volume = single point of failure (see backups).
- **2 nodes:** **no automatic failover.** A lone survivor is 1-of-2, never a majority, so
  `fly pg failover` refuses with _"Not enough machines to meet quorum requirements."_ A
  2-node cluster gives you a redundant data copy but **not** low-RTO failover.
- **3 nodes:** the minimum for real HA / working automatic failover.

Corollary: a "cheap 2-node HA" does not exist here. For durability without a 3rd node,
we rely on **WAL archiving** (enabled — see [Backups & PITR](#backups--point-in-time-recovery-pitr))
rather than a hot standby.

## NEVER destroy a PG machine without unregistering it first

This is the single biggest footgun and caused a production outage. If you
`fly machine destroy` a cluster member, its record **stays registered in repmgr**. The
surviving node then counts a member it can't reach, fails its "am I the true primary?"
check, and **fences itself into the `zombie` state — stopping Postgres entirely.**

Correct order to remove a member:

```bash
# On a surviving node:
fly ssh console -a <pg-app> --machine <survivor-id>
su postgres
repmgr -f /data/repmgr.conf cluster show          # note the departing node's ID
repmgr -f /data/repmgr.conf standby unregister --node-id <DEAD-ID>
# (if it was a primary: `primary unregister` instead)
# THEN destroy the machine + volume.
```

---

## Runbook: migrate a single-node cluster to a new region

**Recommended: dump/restore into a fresh cluster.** It's deterministic, keeps the old
cluster intact as an instant rollback, and avoids every failover/quorum/zombie hazard
below. Downtime is a few minutes for a small DB; acceptable in a quiet window.

```bash
fly volumes snapshots create <old-volume-id>                    # 0. backup
fly postgres create --name <pg-app>-v2 --region <new-region>    # 1. fresh single node
fly scale count 0 -a lion-reader --process-group app --process-group worker --process-group discord  # 2. stop writes
fly postgres import -a <pg-app>-v2 "<source-connection-uri>"    # 3. copy data
fly postgres detach <pg-app>   -a lion-reader                   # 4. repoint app
fly postgres attach <pg-app>-v2 -a lion-reader
# set primary_region = "<new-region>" in fly.toml, then:
fly deploy -a lion-reader
fly scale count <n> -a lion-reader --region <new-region> --process-group app  # + worker/discord
# 5. verify, then: fly apps destroy <pg-app>   (old cluster)
```

**Do NOT** try to migrate by adding a replica in the new region and failing over. On
2-node Flex the failover won't hold quorum; on 3-node it can _revert_ (the old leader
reasserts primary after restart), and destroying nodes afterward risks split-brain and
zombies. We learned this the hard way — the dump/restore is boring and it works.

Whichever region you pick, **keep app + Postgres + Redis co-located.** Set both the app's
`fly.toml` `primary_region` and the PG app's `PRIMARY_REGION`
(`fly config save`/edit/`fly deploy` on the PG app) to the same region — a mismatch blocks
a zombied node from self-healing.

---

## Recovery: split-brain (two primaries)

**Symptom:** `fly machines list` shows two nodes as `primary`; the app may be writing to
one or diverging.

1. **Freeze writes immediately** — app _and_ worker _and_ discord:
   `fly scale count 0 -a lion-reader --process-group app --process-group worker --process-group discord`
2. **Snapshot every volume** (`fly volumes snapshots create …`) — makes everything reversible.
3. **Confirm** with SQL, not the UI: `select pg_is_in_recovery();` on each node. Two `f`s =
   real split-brain.
4. **Pick the winner** = the node the app actually wrote to (check the Flex HAProxy
   `primary1` backend in the logs, or compare recent rows). If writes were purely
   regenerable (e.g. feed fetches with no users online), the choice doesn't matter — keep
   the node in your target region.
5. **Lift the winner's data into a fresh clean cluster** (dump/restore above). Do **not**
   try to repair the split cluster in place — its repmgr state is untrustworthy.

## Recovery: zombie node ("Unable to confirm that we are the true primary")

**Symptom:** `ROLE` shows `zombie`, `pg` check `connection refused`, logs repeat
`Unable to confirm that we are the true primary!`, `Voting member(s): N, Active: 1,
Inactive: …`, and `failed post-init: resolved primary '' does not match ourself`. Postgres
is **stopped by Flex on purpose** — the data is safe on disk; it just won't serve.

**Cause:** a deleted member is still registered (see "NEVER destroy … without
unregistering"), so Flex can't confirm a majority.

**Fix** (worked for us, near-instant, no rebuild needed):

```bash
fly ssh console -a <pg-app> --machine <survivor-id>
su postgres
repmgr -f /data/repmgr.conf cluster show          # find the unreachable ghost node-id(s)
repmgr -f /data/repmgr.conf standby unregister --node-id <GHOST-ID>   # or `primary unregister`
repmgr -f /data/repmgr.conf cluster show          # confirm ONLY the survivor remains
```

The moment the last ghost is unregistered, Flex re-evaluates, logs
`Clearing zombie lock and re-enabling read/write`, and Postgres comes back on its own —
**no machine restart required** (a restart is a fallback way to force re-evaluation, not a
necessity). Verify with `fly checks list -a <pg-app>` (pg/role/vm passing, role=primary).

Caveats:

- `repmgr` talks to Postgres locally on **port 5433**. If `cluster show` errors with a
  connection failure, Postgres is fully stopped and you must restore from snapshot into a
  fresh cluster instead.
- Also ensure the PG app's `PRIMARY_REGION` matches the survivor's actual region, or a
  zombied node won't self-heal.
- A leftover `Priority | 0` on the primary (from prior failover attempts) is cosmetic for a
  lone node; reset it only if you add a replica.

---

## Backups & Point-in-Time Recovery (PITR)

Two independent layers protect the database:

1. **Continuous WAL archiving → Tigris (primary).** Fly flex has built-in WAL-based
   backups: a scheduled base backup plus a continuous stream of WAL segments pushed to a
   Tigris (S3-compatible) bucket. This gives **point-in-time recovery** — restore to any
   instant inside the retention window, not just the last snapshot — with an **RPO of
   seconds** because `--archive-timeout` is set (untuned, a quiet DB's worst-case RPO is
   larger, since WAL otherwise ships only as 16MB segments fill).
2. **Daily volume snapshots (floor).** Fly snapshots the 10GB NVMe volume once a day
   (≈ 5-day retention, ~24h RPO), as the backstop if the WAL archive is ever unavailable.
   Flex volumes are single-host local NVMe (not replicated), so snapshots alone would risk
   ~24h of data on a disk/host failure — which is exactly why WAL archiving is the primary.

We deliberately use Fly's built-in WAL archiving rather than hand-rolling
`wal-g`/`pgBackRest`: the flex image wires up the `archive_command`, the base-backup
schedule, and the Tigris bucket for us, so there is no custom Postgres image to build and
keep patched. A hot standby is intentionally **not** used — its value is low RTO
(auto-failover in seconds), and a standby is not a backup (it replicates bad
deletes/corruption/migrations instantly). A few minutes of downtime on a rare host failure
is acceptable; WAL PITR is what actually protects the data. (Issue #1376.)

Backups live on Fly Tigris — already our object-storage and hosting provider (see the
privacy policy's "Object Storage" subsection) — so no new data processor is introduced.

### Current production status

Backups are **enabled** on `lion-reader-pg` (turned on by `--enable-backups` at create).
Current config (`fly postgres backup config show -a lion-reader-pg`):

```
ArchiveTimeout      = 60s
RecoveryWindow      = 7d
FullBackupFrequency = 24h
MinimumRedundancy   = 3
```

i.e. a **7-day PITR window** with worst-case **RPO ~60s**.

### Enable / configure

```bash
# One-time, only if a cluster was created without --enable-backups:
fly postgres backup enable -a lion-reader-pg

# Show / change the config (retention, schedule, bucket):
fly postgres backup config show   -a lion-reader-pg
fly postgres backup config update -a lion-reader-pg --recovery-window 7d --archive-timeout 60s
```

Config flags (`fly postgres backup config update`): `--recovery-window` (retention window
PITR can target), `--full-backup-frequency` (base-backup cadence, default 24h),
`--archive-timeout` (max wait before forcing a WAL push — bounds worst-case RPO on an idle
DB), `--minimum-redundancy` (min base backups to keep). Durations are strings like
`7d` / `60s`; run with `--help` to confirm the accepted format on the installed flex
version. Add a bucket lifecycle rule only if you want a hard backstop beyond
`--recovery-window`.

### List backups / on-demand base backup

```bash
fly postgres backup list   -a lion-reader-pg
fly postgres backup create -a lion-reader-pg   # also resets the base-backup timer
```

### Restore to a point in time (PITR)

Restores always go into a **new** cluster — never in place. `--restore-target-time` takes
an RFC3339 timestamp:

```bash
# Restore lion-reader-pg's archive into a fresh cluster, as of a chosen instant:
fly postgres backup restore lion-reader-pg-restore \
  -a lion-reader-pg \
  --restore-target-time 2026-07-18T14:30:00Z

# Verify the data, then repoint the app at the restored cluster:
fly postgres detach lion-reader-pg           --app lion-reader   # unbind the old DB
fly postgres attach lion-reader-pg-restore   --app lion-reader   # sets DATABASE_URL to the new DB
fly apps restart lion-reader
```

Omit `--restore-target-time` **only** when you want the newest possible state (e.g.
recovering from hardware/host loss). For corruption or a bad delete/migration, you **must**
target a time _before_ the incident — otherwise the WAL replay faithfully re-applies the
damage you're recovering from. Use `--restore-target-name` to select a specific base backup
by id/alias, and `--restore-target-inclusive=false` to stop _before_ the target time. Run
`fly postgres backup restore --help` to confirm flag names before a real restore — flex's
flags occasionally change.

### Restore drill

Do this periodically — an untested backup isn't a backup.

1. Restore ~1h back into a throwaway cluster:
   ```bash
   fly postgres backup restore lion-reader-pg-drill -a lion-reader-pg \
     --restore-target-time <RFC3339 ~1h ago>
   ```
2. `fly postgres connect -a lion-reader-pg-drill --database lion_reader` and spot-check row
   counts / a recent entry against production.
3. Confirm the target time landed where expected — e.g. a row written _after_ the target
   time should be absent.
4. `fly apps destroy lion-reader-pg-drill` to clean up (drill clusters cost money).

### Monitoring

A stalled archive is the dangerous _silent_ failure: if WAL stops shipping, the DB looks
healthy while PITR quietly stops advancing. Check regularly:

- `fly postgres backup list` shows a recent base backup, and `fly postgres backup config
show` reports healthy/recent archiving.
- On [fly-metrics.net](https://fly-metrics.net), watch the primary's `pg_wal` directory —
  WAL segments piling up locally means archiving is failing to drain them.
- Eyeball the Tigris backup bucket occasionally for recent WAL objects.
- **Follow-up:** wire an automated alert (worker job or external cron) that pages if the
  newest archived WAL is older than N minutes — the manual checks above are the interim.
