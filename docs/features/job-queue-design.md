# Job Queue Design

The job queue manages recurring background tasks like feed fetching and WebSub renewal. It uses a simple Postgres-based model with one row per scheduled task.

## Design Principles

1. **One job per task**: Each feed has exactly one `fetch_feed` job row. There's one `renew_websub` job for all WebSub renewals. Jobs are persistent, not ephemeral.

2. **Declarative scheduling**: The `next_run_at` column declares when a job should run next. The worker polls for due jobs.

3. **Enable/disable over create/delete**: When a feed has no subscribers, we disable its job rather than deleting it. Re-subscribing re-enables it.

4. **Stale job recovery**: Jobs track `running_since` timestamp. Jobs running for > 5 minutes are assumed crashed and become claimable again.

## Schema

```sql
CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,              -- 'fetch_feed', 'renew_websub'
  payload JSONB NOT NULL,          -- { feedId: '...' } for fetch_feed

  -- Scheduling state
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ,
  running_since TIMESTAMPTZ,       -- NULL = not running

  -- Tracking
  last_run_at TIMESTAMPTZ,
  last_error TEXT,
  consecutive_failures INT NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

-- Index for polling: enabled jobs that are due
CREATE INDEX idx_jobs_polling ON jobs (next_run_at) WHERE enabled = true;

-- Index for looking up feed jobs by feedId
CREATE INDEX idx_jobs_feed_id ON jobs ((payload->>'feedId')) WHERE type = 'fetch_feed';
```

## Job Types

### `fetch_feed`

Fetches a feed and processes new entries.

**Payload**: `{ feedId: string }`

**Lifecycle**:

1. Created when first user subscribes to a feed
2. Runs at `next_run_at`, updates entries, calculates next fetch time
3. Disabled when last subscriber unsubscribes
4. Re-enabled when someone subscribes again

**Failure handling**: Failures tracked on `feeds.consecutive_failures`. Backoff applied to `next_run_at`.

### `renew_websub`

Renews expiring WebSub subscriptions.

**Payload**: `{}` (empty)

**Lifecycle**:

1. Created at application startup if it doesn't exist
2. Runs daily, renews all WebSub subscriptions expiring within 24 hours
3. Always enabled

**Failure handling**: Failures tracked on `jobs.consecutive_failures` since there's no associated feed.

## Worker Behavior

### Claiming Jobs

```sql
UPDATE jobs
SET running_since = now()
WHERE id = (
  SELECT id FROM jobs
  WHERE enabled = true
    AND next_run_at <= now()
    AND (running_since IS NULL OR running_since < now() - interval '5 minutes')
  ORDER BY next_run_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *
```

The query:

- Only claims enabled jobs
- Only claims jobs where `next_run_at` is in the past
- Skips jobs currently running (`running_since` is recent)
- Reclaims jobs running > 5 minutes (assumed crashed)
- Uses `FOR UPDATE SKIP LOCKED` for concurrent workers

### Finishing Jobs

**On success**:

```sql
UPDATE jobs SET
  running_since = NULL,
  last_run_at = now(),
  next_run_at = :calculated_next_run,
  last_error = NULL,
  consecutive_failures = 0,
  updated_at = now()
WHERE id = :job_id
```

**On failure**:

```sql
UPDATE jobs SET
  running_since = NULL,
  last_run_at = now(),
  next_run_at = :backoff_next_run,
  last_error = :error,
  consecutive_failures = consecutive_failures + 1,
  updated_at = now()
WHERE id = :job_id
```

## Subscription Integration

### When user subscribes to a new feed

1. Create feed row
2. Create job with `enabled = true`, `next_run_at = now()`
3. Create subscription

### When user subscribes to an existing feed

1. Enable job (idempotent):
   ```sql
   UPDATE jobs SET enabled = true, updated_at = now()
   WHERE payload->>'feedId' = :feed_id AND type = 'fetch_feed'
   RETURNING next_run_at
   ```
2. Copy `next_run_at` to `feeds.next_fetch_at` (for UI/debugging)
3. Create subscription

### When user unsubscribes

1. Soft-delete subscription
2. Sync job enabled state atomically:
   ```sql
   UPDATE jobs SET
     enabled = EXISTS (
       SELECT 1 FROM subscriptions
       WHERE feed_id = :feed_id AND unsubscribed_at IS NULL
     ),
     updated_at = now()
   WHERE payload->>'feedId' = :feed_id AND type = 'fetch_feed'
   RETURNING enabled
   ```
3. If job became disabled, set `feeds.next_fetch_at = NULL`

This atomic query ensures the job is only disabled when the last subscriber leaves.

## Comparison with Previous Design

| Aspect          | Previous                                        | Current                                       |
| --------------- | ----------------------------------------------- | --------------------------------------------- |
| Jobs per feed   | Many (one per fetch)                            | One                                           |
| Job lifecycle   | Create → Run → Complete → Create new            | Create → Run → Update same row                |
| Status tracking | `status` enum: pending/running/completed/failed | `enabled` boolean + `running_since` timestamp |
| Cleanup needed  | Yes (completed jobs accumulate)                 | No                                            |
| On unsubscribe  | Job runs, finds no subscribers, skips           | Disable job immediately                       |
| On resubscribe  | Bug: no job created                             | Enable existing job                           |

## Edge Cases

### Disabling a running job

A job can be disabled while running (`enabled = false` but `running_since` is set). The job completes its current run normally. On the next poll cycle, it won't be claimed because `enabled = false`.

### Creating a job for a feed that already has one

`createFeedJob` is idempotent. If a job already exists for the feed, it enables it (if disabled) rather than creating a duplicate.

### Job for feed with no subscribers

When the last subscriber leaves, we disable the job but keep its `next_run_at`. When someone resubscribes, we re-enable it. The next run happens at the previously scheduled time (or immediately if that time has passed).

### feeds.next_fetch_at synchronization

The `feeds.next_fetch_at` column mirrors the job's `next_run_at` for UI and debugging purposes:

- On disable: `feeds.next_fetch_at = NULL`
- On enable: `feeds.next_fetch_at = jobs.next_run_at`
- After job runs: both are updated to the calculated next time
