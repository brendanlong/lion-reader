# Entry State Update Idempotency

## Problem

When multiple clients (browser tabs, MCP server, etc.) send conflicting read/star updates, the last-write-wins behavior can cause unexpected state:

1. User marks entry as read in Tab A
2. Tab B (with stale state) marks same entry as unread
3. Entry ends up unread despite user's intent in Tab A

Without timestamps, we can't distinguish "newer user intent" from "stale client state."

## Solution

Add per-field change timestamps to `user_entries` and use conditional updates that only apply if the incoming change is newer.

## Database Changes

Add two columns to `user_entries`:

```sql
ALTER TABLE user_entries
  ADD COLUMN read_changed_at timestamptz NOT NULL DEFAULT NOW(),
  ADD COLUMN starred_changed_at timestamptz NOT NULL DEFAULT NOW();
```

- `read_changed_at`: When `read` state was last set
- `starred_changed_at`: When `starred` state was last set
- Existing rows get `NOW()` as their timestamp during migration
- Using `NOT NULL DEFAULT NOW()` eliminates NULL checks in update logic

## API Changes

### Input

Add per-entry timestamps for bulk operations and single timestamp for batch operations:

```typescript
// entries.markRead - supports per-entry timestamps for offline sync
{
  entries: Array<{ id: string; changedAt?: Date }>;  // Per-entry timestamps
  read: boolean;
}

// entries.star/unstar - single entry
{
  id: string;
  changedAt?: Date;
}

// entries.markAllRead - single timestamp for all (user is online, acting now)
{
  // ... existing filters
  changedAt?: Date;
}
```

For `markRead`, each entry can have its own timestamp. This supports offline sync where the user marked entry A as read at 10:00 AM and entry B at 10:05 AM - each should use its original timestamp when syncing back online.

If `changedAt` is omitted for an entry, it defaults to the current server time.

### Update Logic

Always write the timestamp when a field is set, even if the value doesn't change. This ensures true idempotency: sending the same request twice with the same timestamp results in the second being a no-op (timestamp already >= incoming).

**markEntriesRead:**

```sql
UPDATE user_entries
SET read = $read,
    read_changed_at = $changedAt,
    updated_at = NOW()
WHERE user_id = $userId
  AND entry_id = ANY($entryIds)
  AND read_changed_at < $changedAt
RETURNING entry_id, read, starred;
```

**updateEntryStarred:**

```sql
UPDATE user_entries
SET starred = $starred,
    starred_changed_at = $changedAt,
    updated_at = NOW()
WHERE user_id = $userId
  AND entry_id = $entryId
  AND starred_changed_at < $changedAt
RETURNING entry_id, read, starred;
```

### Behavior When `changedAt` Not Provided

If client doesn't provide `changedAt`, use current server time. This means:

- Backwards compatible with existing clients
- Request without timestamp effectively means "apply now"
- Will win against past changes, lose to concurrent changes with newer timestamps

## Client Behavior

### Generating Timestamps

Client generates timestamp when user performs the action:

```typescript
const markRead = (entryIds: string[], read: boolean) => {
  const changedAt = new Date();
  return trpc.entries.markRead.mutate({ entryIds, read, changedAt });
};
```

### Handling Rejections

If the update is rejected (newer change exists), the response returns current state which may differ from requested state. Client should:

1. Update local cache with returned state (already happens with current optimistic update logic)
2. Optionally show a toast if user's action was rejected

In practice, rejections are rare (requires near-simultaneous conflicting actions) and the "correct" state is shown either way.

## Response Format

No change to response structure. Returns current entry state for all requested entries:

```typescript
{
  entries: Array<{ id: string; read: boolean; starred: boolean }>;
  // ... unread counts
}
```

For bulk operations, always return the final state of all requested entries, regardless of whether they were actually modified. The client just needs to know the current state—it doesn't need to know how we got there or which entries were skipped due to newer timestamps.

## SSE Events

Only publish state change events when rows are actually updated. The conditional update naturally handles this - if no rows match the WHERE clause, no event is published.

## Migration

1. Add columns with `NOT NULL DEFAULT NOW()`
2. Existing rows get current timestamp (any new update will win)
3. Going forward, all updates set the timestamp

## Edge Cases

### Clock Skew

Sub-second precision isn't critical. If two users genuinely click within milliseconds of each other, either outcome is acceptable. The goal is preventing obviously-stale updates, not perfect ordering.

### Bulk Mark-All-Read

When marking all entries in a feed as read, use a single timestamp for the batch. This ensures consistency within the operation.

### Initial Entry Creation

When `user_entries` row is created (on first view), both `read_changed_at` and `starred_changed_at` are set to `NOW()`. The initial state (`read: false`, `starred: false`) uses creation time as its timestamp.

## Testing

1. **Basic idempotency**: Same update with same timestamp is no-op
2. **Newer wins**: Update with newer timestamp overwrites older state
3. **Older rejected**: Update with older timestamp is ignored
4. **Mixed updates**: Changing read doesn't affect starred timestamp and vice versa
5. **Bulk updates**: Returns final state for all entries even when some are skipped
