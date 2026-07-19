# Postgres Operations: Backups & Point-in-Time Recovery (PITR)

Break-glass runbook for the production Postgres cluster (`lion-reader-pg`, unmanaged
Fly Postgres flex — see [DEPLOYMENT.md](DEPLOYMENT.md) for the cluster shape and the
"Operating unmanaged Postgres" duties). Most of this you never touch; read it when
you actually need to restore, tune retention, or run a drill.

## What's protecting the database

Two independent layers:

1. **Continuous WAL archiving → Tigris (primary).** Fly flex has built-in WAL-based
   backups: a scheduled base backup plus a continuous stream of WAL segments pushed
   to a Tigris (S3-compatible) bucket. This gives **point-in-time recovery** — you
   can restore to any instant inside the retention window, not just the last
   snapshot — with an **RPO of seconds** because `--archive-timeout` is set (untuned,
   a quiet DB's worst-case RPO is larger, since WAL otherwise ships only as 16MB
   segments fill).
2. **Daily volume snapshots (floor).** Fly snapshots the 10GB NVMe volume once a day
   (~24h RPO), as the backstop if the WAL archive is ever unavailable (restore path
   in [Backup, Restores, & Snapshots](https://fly.io/docs/postgres/managing/backup-and-restore/)).

We deliberately use Fly's built-in WAL archiving rather than hand-rolling
`wal-g`/`pgBackRest`: the flex image wires up the `archive_command`, the base-backup
schedule, and the Tigris bucket for us, so there is no custom Postgres image to build
and keep patched. A hot standby is intentionally **not** used — its value is low RTO
(auto-failover in seconds), and a standby is not a backup (it replicates bad
deletes/corruption/migrations instantly). A few minutes of downtime on a rare host
failure is acceptable; WAL PITR is what actually protects the data. (Issue #1376.)

Backups live on Fly Tigris — already our object-storage and hosting provider (see the
privacy policy's "Object Storage" subsection) — so no new data processor is
introduced.

## Current production status

Backups are **enabled** on `lion-reader-pg` (turned on by `--enable-backups` at
create). Current config (`flyctl postgres backup config show -a lion-reader-pg`):

```
ArchiveTimeout      = 60s
RecoveryWindow      = 7d
FullBackupFrequency = 24h
MinimumRedundancy   = 3
```

i.e. a **7-day PITR window** with worst-case **RPO ~60s**.

## Enable / verify

```bash
# One-time, only if a cluster was created without --enable-backups:
flyctl postgres backup enable -a lion-reader-pg

# Show the current backup configuration (retention, schedule, bucket):
flyctl postgres backup config show -a lion-reader-pg
```

## Configure retention / schedule

`flyctl postgres backup config update`:

| Flag                      | Meaning                                                                | Default |
| ------------------------- | ---------------------------------------------------------------------- | ------- |
| `--recovery-window`       | How far back PITR can target (retention window)                        | —       |
| `--full-backup-frequency` | Base-backup cadence                                                    | 24h     |
| `--archive-timeout`       | Max wait before forcing a WAL push (caps worst-case RPO on an idle DB) | —       |
| `--minimum-redundancy`    | Minimum number of base backups to keep                                 | —       |

```bash
# The values currently set in production — 7-day PITR window, WAL push at
# least every 60s (re-run to change them):
flyctl postgres backup config update -a lion-reader-pg \
  --recovery-window 7d \
  --archive-timeout 60s
```

WAL is normally shipped as segments fill; `--archive-timeout` bounds the worst-case
RPO when the DB is quiet. Retention on Tigris is governed by `--recovery-window`; add
a bucket lifecycle rule only if you want a hard backstop beyond it. (Duration flags
take strings like `7d` / `60s` — run the command with `--help` to confirm the accepted
format on the installed flex version.)

## List backups / take an on-demand base backup

```bash
flyctl postgres backup list -a lion-reader-pg
flyctl postgres backup create -a lion-reader-pg   # also resets the base-backup timer
```

## Restore to a point in time (PITR)

Restores always go into a **new** cluster — never in place. `--restore-target-time`
takes an RFC3339 timestamp:

```bash
# Restore lion-reader-pg's archive into a fresh cluster, as of a chosen instant:
flyctl postgres backup restore lion-reader-pg-restore \
  -a lion-reader-pg \
  --restore-target-time 2026-07-18T14:30:00Z

# Verify the data, then repoint the app at the restored cluster:
flyctl postgres detach lion-reader-pg --app lion-reader          # unbind the old DB
flyctl postgres attach lion-reader-pg-restore --app lion-reader  # sets DATABASE_URL to the new DB
flyctl apps restart lion-reader
```

Omit `--restore-target-time` **only** when you want the newest possible state (e.g.
recovering from hardware/host loss). For corruption or a bad delete/migration, you
**must** target a time _before_ the incident — otherwise the WAL replay faithfully
re-applies the damage you're recovering from. Use `--restore-target-name` to select a
specific base backup by id/alias, and `--restore-target-inclusive=false` to stop
_before_ the target time. Run `flyctl postgres backup restore --help` to confirm flag
names before a real restore — flex's flags occasionally change.

## Restore drill

Do this periodically — an untested backup isn't a backup.

1. Restore ~1h back into a throwaway cluster:
   ```bash
   flyctl postgres backup restore lion-reader-pg-drill -a lion-reader-pg \
     --restore-target-time <RFC3339 ~1h ago>
   ```
2. `flyctl postgres connect -a lion-reader-pg-drill --database lion_reader` and
   spot-check row counts / a recent entry against production.
3. Confirm the target time landed where expected — e.g. a row written _after_ the
   target time should be absent.
4. `flyctl apps destroy lion-reader-pg-drill` to clean up (drill clusters cost money).

## Monitoring

A stalled archive is the dangerous _silent_ failure: if WAL stops shipping, the DB
looks healthy while PITR quietly stops advancing. Check regularly:

- `flyctl postgres backup list` shows a recent base backup, and
  `flyctl postgres backup config show` reports healthy/recent archiving.
- On [fly-metrics.net](https://fly-metrics.net), watch the primary's `pg_wal`
  directory — WAL segments piling up locally means archiving is failing to drain them.
- Eyeball the Tigris backup bucket occasionally for recent WAL objects.
- **Follow-up:** wire an automated alert (worker job or external cron) that pages if
  the newest archived WAL is older than N minutes — the manual checks above are the
  interim.
