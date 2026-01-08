# Pull-Based Sync Endpoint Design

This document describes the design for a pull-based sync endpoint that provides incremental synchronization as a fallback when SSE real-time updates are unavailable.

## Overview

Currently, the web client relies on Server-Sent Events (SSE) via Redis pub/sub for real-time updates. If Redis is unavailable or the SSE connection fails, clients have no way to catch up on missed events without a full page refresh.

This feature adds:

1. A `/sync` endpoint for incremental pull-based synchronization
2. Graceful SSE degradation when Redis is unavailable
3. Client-side polling fallback with periodic SSE reconnection attempts

### Key Design Decisions

1. **Timestamp-based sync**: Use `since` timestamp to fetch only changed items
2. **Unified endpoint**: Single endpoint returns all entity types (entries, subscriptions, tags)
3. **Server-provided sync timestamp**: Response includes `syncedAt` for use as next `since` value
4. **Graceful SSE degradation**: Return 503 with retry hint when Redis is down
5. **Hybrid client strategy**: Poll as fallback, periodically retry SSE

### Benefits

- **Redis resilience**: App remains functional when Redis is unavailable
- **Catch-up after disconnect**: Clients sync missed events after SSE reconnection
- **Mobile-ready**: Same endpoint can be used by Android app (future)
- **Offline support foundation**: Enables future PWA/offline functionality

---

## Architecture

### Sync Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        Web Client                                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  SSE Active  │───▶│  SSE Fails   │───▶│  Poll Mode   │      │
│  │  (primary)   │    │  (detect)    │    │  (fallback)  │      │
│  └──────────────┘    └──────────────┘    └──────┬───────┘      │
│         ▲                                        │              │
│         │              ┌─────────────────────────┘              │
│         │              │ Periodic SSE retry                     │
│         │              ▼                                        │
│         └──────────────────────────────────────────────────────│
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ GET /api/trpc/sync.changes?since=...
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Server                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Sync Endpoint                          │  │
│  │  - Query entries updated since timestamp                  │  │
│  │  - Query subscriptions created/deleted since timestamp    │  │
│  │  - Query tags created since timestamp                     │  │
│  │  - Return unified response with syncedAt                  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                     PostgreSQL                            │  │
│  │  - entries (created_at, updated_at)                       │  │
│  │  - user_entries (updated_at) ← NEW                        │  │
│  │  - subscriptions (created_at, unsubscribed_at)            │  │
│  │  - tags (created_at)                                      │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### SSE Degradation Flow

```
GET /api/v1/events
         │
         ▼
┌─────────────────────┐
│  Check Redis Health │
└──────────┬──────────┘
           │
     ┌─────┴─────┐
     │           │
   Redis OK    Redis Down
     │           │
     ▼           ▼
┌─────────┐  ┌──────────────────────────┐
│ Normal  │  │ 503 Service Unavailable  │
│  SSE    │  │ Retry-After: 30          │
│ Stream  │  │ X-Fallback-Sync: true    │
└─────────┘  └──────────────────────────┘
```

---

## API Design

### Sync Endpoint

```
GET /api/trpc/sync.changes
```

**Input:**

```typescript
{
  since?: string;  // ISO 8601 timestamp, omit for initial sync
}
```

**Output:**

```typescript
{
  entries: {
    // New entries created since timestamp
    created: Array<{
      id: string;
      feedId: string;
      type: "web" | "email" | "saved";
      url: string | null;
      title: string | null;
      author: string | null;
      summary: string | null;
      publishedAt: string | null;  // ISO 8601
      fetchedAt: string;
      read: boolean;
      starred: boolean;
      feedTitle: string | null;
      siteName: string | null;
    }>;

    // Entries with state changes (read/starred toggled)
    updated: Array<{
      id: string;
      read: boolean;
      starred: boolean;
    }>;

    // Entry IDs no longer visible (unsubscribed from feed, not starred)
    removed: string[];
  };

  subscriptions: {
    // New subscriptions
    created: Array<{
      id: string;
      feedId: string;
      feedTitle: string | null;
      feedUrl: string | null;
      customTitle: string | null;
      subscribedAt: string;
    }>;

    // Unsubscribed feeds
    removed: string[];  // subscription IDs
  };

  tags: {
    // New or updated tags
    created: Array<{
      id: string;
      name: string;
      color: string | null;
    }>;

    // Deleted tags
    removed: string[];  // tag IDs
  };

  // Use this as the `since` value for next sync
  syncedAt: string;  // ISO 8601 timestamp
}
```

### SSE Endpoint Changes

The existing `/api/v1/events` endpoint will be modified to:

1. Check Redis connectivity before establishing SSE stream
2. Return `503 Service Unavailable` if Redis is down
3. Include headers to hint at fallback behavior:
   - `Retry-After: 30` - suggest retry after 30 seconds
   - `X-Fallback-Sync: true` - indicate sync endpoint is available

---

## Database Changes

### New Column: user_entries.updated_at

The `user_entries` table currently lacks an `updated_at` column, which is needed to track when read/starred state changes.

**Migration:**

```sql
ALTER TABLE user_entries
ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Index for efficient sync queries
CREATE INDEX idx_user_entries_updated_at
ON user_entries (user_id, updated_at);
```

**Schema change:**

```typescript
export const userEntries = pgTable("user_entries", {
  // ... existing columns
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

### Updated Triggers

Mutations that change `read` or `starred` must also update `updated_at`:

```typescript
// In entries router mutations
.set({
  read: input.read,
  updatedAt: new Date(),  // ← Add this
})
```

---

## Client Implementation

### Hook Changes: useRealtimeUpdates

The `useRealtimeUpdates` hook will be extended with:

1. **SSE unavailable detection**: Handle 503 responses from SSE endpoint
2. **Polling fallback**: Start polling sync endpoint when SSE fails
3. **Periodic SSE retry**: Attempt SSE reconnection every N seconds
4. **Sync on reconnect**: Call sync endpoint after successful SSE reconnection

```typescript
// Conceptual state machine
type SyncMode =
  | { type: "sse"; status: ConnectionStatus }
  | { type: "polling"; lastSync: string; retrySSEAt: number };

// Polling interval when in fallback mode
const POLL_INTERVAL_MS = 30_000; // 30 seconds

// How often to retry SSE while polling
const SSE_RETRY_INTERVAL_MS = 60_000; // 1 minute
```

### Sync Flow

```typescript
// On SSE connection established
function onSSEConnected(lastSyncedAt: string | null) {
  if (lastSyncedAt) {
    // Catch up on any missed events
    syncChanges({ since: lastSyncedAt });
  }
  setSyncMode({ type: "sse", status: "connected" });
}

// On SSE connection failed (503 or Redis error)
function onSSEUnavailable() {
  setSyncMode({
    type: "polling",
    lastSync: new Date().toISOString(),
    retrySSEAt: Date.now() + SSE_RETRY_INTERVAL_MS,
  });
  startPolling();
}

// Polling loop
async function poll() {
  const result = await syncChanges({ since: lastSync });
  setLastSync(result.syncedAt);

  // Apply changes to React Query cache
  applyChangesToCache(result);

  // Check if we should retry SSE
  if (Date.now() >= retrySSEAt) {
    attemptSSEReconnect();
  }
}
```

---

## Performance Considerations

### Query Optimization

The sync endpoint needs efficient queries for each entity type:

1. **Entries created**: Use `entries.created_at > since` with user visibility join
2. **Entry state changes**: Use `user_entries.updated_at > since`
3. **Subscriptions**: Use `subscriptions.created_at > since` OR `subscriptions.unsubscribed_at > since`
4. **Tags**: Use `tags.created_at > since`

All queries should use the user ID for filtering and leverage existing indexes.

### Pagination

For initial sync (no `since` parameter), the endpoint should:

- Limit entries to most recent N (e.g., 1000)
- Return `hasMore: true` if truncated
- Client can use standard list endpoints to load more

### Caching

The sync endpoint should NOT be cached as it returns time-sensitive data.

---

## Implementation Plan

### Phase 1: Database & Server

1. Add migration for `user_entries.updated_at`
2. Update entry mutations to set `updated_at`
3. Implement `sync.changes` tRPC procedure
4. Add Redis health check to SSE endpoint

### Phase 2: Client

5. Extend `useRealtimeUpdates` with polling fallback
6. Add sync endpoint integration
7. Implement cache update logic for sync results

### Phase 3: Testing

8. Integration tests for sync endpoint
9. Test SSE fallback behavior
10. Test sync after SSE reconnection

---

## Future Considerations

### Android App Integration

The Android app currently does full refreshes. This sync endpoint enables:

- Incremental sync instead of full refresh
- Reduced bandwidth and battery usage
- Better offline-to-online transition

### Offline Web Support

This foundation enables future PWA features:

- Background sync when coming online
- Conflict resolution for offline actions
- Local-first architecture
