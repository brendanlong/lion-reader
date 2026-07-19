# Fly.io Postgres (Flex) — Operations, Gotchas & Recovery

Our database is an **unmanaged Fly Postgres Flex** cluster (`lion-reader-pg`, image
`flyio/postgres-flex`). "Unmanaged" means **we** own operations, backups, and disaster
recovery — Fly support does not. This doc is the runbook for the failure modes that
actually bit us and how to avoid / recover from them.

> **Golden rule:** before _any_ destructive Postgres operation (destroying a machine,
> failover, region move), **take a volume snapshot first**:
> `fly volumes snapshots create <volume-id>`. Snapshots are cheap, retained
> independently of the volume, and are your only undo button.

Related: [DEPLOYMENT.md](../DEPLOYMENT.md) · continuous backups are tracked in
issue #1376 (WAL archiving / PITR).

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
prefer **WAL archiving** (#1376) over a hot standby.

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

## Backups (until #1376 lands)

Today the only backup is Fly's periodic **volume snapshots** (≈ daily, 5-day retention) →
**RPO can be ~24h**, and Flex volumes are single-host local NVMe (not replicated). A
single-node cluster with only snapshots can lose up to a day of data on a disk/host
failure. Continuous **WAL archiving to object storage** (`wal-g`/`pgBackRest` → R2/S3)
brings RPO down to seconds and is the higher-value spend than a hot standby — tracked in
issue #1376.
