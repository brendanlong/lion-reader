# Delta-Based State Management with Zustand

## Problem Statement

The current React Query-based architecture has several issues:

1. **Complex cache synchronization**: 110+ manual cache update sites across the codebase
2. **Over-fetching**: Every mutation recalculates ALL subscription/tag counts, even for data not on screen
3. **Fragile optimistic updates**: Coordinating updates across `entries.list`, `subscriptions.list`, and `tags.list` is error-prone
4. **Frequent bugs**: Hard to maintain consistency between local optimistic updates and server state
5. **Missing event windows**: SSE reconnection doesn't properly track sync cursor, risking data loss

### Example: Current `markRead` Flow

```tsx
// CLIENT: Mark 1 entry read
markRead({ ids: ["entry-1"], read: true })

// SERVER: Expensive queries
1. Update entry read state
2. Find ALL subscriptions containing this entry's feed
3. Recalculate unread counts for ALL those subscriptions (expensive joins)
4. Find ALL tags on those subscriptions
5. Recalculate unread counts for ALL those tags (even more expensive joins)
6. Return all counts to client

// CLIENT: Manual cache updates
1. Update entries.list (optimistic)
2. Update entries.get via normy propagation
3. Update subscriptions.list with new counts
4. Update tags.list with new counts
5. Handle rollback on error
```

**Cost**: 3-5 complex queries per mutation + manual cache coordination

## Proposed Architecture

### Mental Model

```
Server (RSC payloads)     →  Canonical state on navigation
SSE/Polling               →  Incremental updates between navigations
Zustand                   →  Client-side diff layer (optimistic + real-time)
```

The Zustand store **doesn't duplicate server data** — it stores adjustments:

```tsx
const useStore = create((set) => ({
  // Diffs, not copies
  readIds: new Set<string>(), // "these are now read"
  starredIds: new Set<string>(), // "these are now starred"
  subscriptionCountDeltas: {}, // { [subId]: -2 }
  tagCountDeltas: {}, // { [tagId]: +1 }
  pendingEntries: [], // from SSE, not yet in server state

  // When server renders fresh data, clear the diffs
  reset: () =>
    set({
      readIds: new Set(),
      starredIds: new Set(),
      subscriptionCountDeltas: {},
      tagCountDeltas: {},
      pendingEntries: [],
    }),
}));
```

Components merge at render time:

```tsx
function Sidebar() {
  const { data } = trpc.subscriptions.list.useQuery(undefined, {
    staleTime: Infinity, // Never auto-refetch
  });

  const deltas = useStore((s) => s.subscriptionCountDeltas);

  const subscriptions = data?.items.map((sub) => ({
    ...sub,
    unreadCount: Math.max(0, sub.unreadCount + (deltas[sub.id] || 0)),
  }));
}
```

### Simplified Mutation Flow

```tsx
// CLIENT: Mark entry read
markRead({ ids: ["entry-1"], read: true })

// Zustand update (instant)
useStore.getState().markRead("entry-1", "subscription-1");
// → readIds: Set(["entry-1"])
// → subscriptionCountDeltas: { "subscription-1": -1 }

// SERVER: Simple update (1 query)
UPDATE user_entries SET read = true WHERE entry_id = 'entry-1'

// CLIENT: No cache updates needed!
// UI reflects change via Zustand delta merge
```

**Cost**: 1 simple update query + Zustand update (instant)

## Data Flow

### Initial Page Load

1. **RSC Layout** generates initial sync cursor: `new Date().toISOString()`
2. **RSC** passes cursor through layout props
3. **Client** initializes `useRealtimeUpdates` with cursor
4. **React Query** fetches initial data (once)
5. **Zustand** starts with empty deltas

### Own Mutations (e.g., mark read)

1. **Client** calls mutation
2. **Zustand** updates deltas (optimistic)
3. **Server** updates database
4. **Client** renders with merged deltas (instant feedback)
5. On error: **Zustand** rolls back deltas

### SSE Events (e.g., new entry from another device)

1. **Server** sends event with `id: <timestamp>` (SSE standard)
2. **Client** receives event
3. **Zustand** applies delta
4. **Client** updates `lastSyncedAt` from `event.lastEventId`
5. **UI** reflects change via merged deltas

### Polling Mode (SSE unavailable)

1. **Client** calls `sync.changes({ since: lastSyncedAt })` every 30s
2. **Server** returns incremental changes
3. **Client** pushes changes to Zustand (same interface as SSE)
4. **Zustand** accumulates deltas

### SSE Reconnection

1. **SSE** reconnects
2. **Client** calls `sync.changes({ since: lastSyncedAt })` for catch-up
3. **Zustand** applies final deltas (idempotent)
4. **SSE** takes over from polling

### Navigation

1. **User** navigates to new page
2. **React Query** serves cached data (no refetch needed!)
3. **Zustand** deltas persist across navigation
4. **UI** remains instantly responsive

### Full Refresh (optional)

Only needed when:

- Sync gap detected (server truncated history)
- User manually triggers refresh
- Long idle period (optional background refresh)

Flow:

1. Clear Zustand deltas
2. Invalidate React Query caches
3. Refetch fresh data
4. Start accumulating new deltas

## Server Changes

### SSE Endpoint Changes

**Add cursor to every event:**

```tsx
// /api/v1/events/route.ts
function formatSSEFeedEvent(event: FeedEvent): string {
  const cursor = new Date().toISOString();
  return `event: ${event.type}\nid: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`;
}

function formatSSEUserEvent(event: UserEvent): string {
  const cursor = new Date().toISOString();
  return `event: ${event.type}\nid: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`;
}
```

**Send initial cursor on connection:**

```tsx
// After subscribing to channels
const initialCursor = new Date().toISOString();
send(
  `event: connected\nid: ${initialCursor}\ndata: ${JSON.stringify({ cursor: initialCursor })}\n\n`
);
```

### Mutation Simplification

**Remove count calculations from `markRead`:**

```tsx
// Before: Complex query with subscription/tag count recalculation (lines 612-717)
// After: Simple update
markRead: protectedProcedure
  .input(z.object({ ids: z.array(z.string()), read: z.boolean() }))
  .output(z.object({ success: z.boolean() }))
  .mutation(async ({ ctx, input }) => {
    await ctx.db
      .update(userEntries)
      .set({ read: input.read, updatedAt: new Date() })
      .where(
        and(eq(userEntries.userId, ctx.session.user.id), inArray(userEntries.entryId, input.ids))
      );

    return { success: true };
  });
```

**Same simplification for `star`, `unstar`, etc.**

### Sync Endpoint Enhancement

**Handle null cursor gracefully:**

```tsx
changes: protectedProcedure
  .input(z.object({ since: z.string().datetime().optional() }))
  .query(async ({ ctx, input }) => {
    // If no cursor, return recent changes (last hour)
    const sinceDate = input.since ? new Date(input.since) : new Date(Date.now() - 60 * 60 * 1000);

    // ... existing query logic
  });
```

## Client Changes

### 1. Zustand Store

**Create `src/lib/store/realtime.ts`:**

```tsx
import { create } from "zustand";

interface RealtimeStore {
  // Entry state diffs
  readIds: Set<string>;
  starredIds: Set<string>;
  newEntryIds: Set<string>;

  // Count deltas
  subscriptionCountDeltas: Record<string, number>;
  tagCountDeltas: Record<string, number>;

  // Pending data
  pendingEntries: Array<{ id: string; subscriptionId: string }>;
  hasNewEntries: boolean;

  // Actions - idempotent operations
  markRead: (entryId: string, subscriptionId: string) => void;
  markUnread: (entryId: string, subscriptionId: string) => void;
  toggleStar: (entryId: string, currentlyStarred: boolean) => void;
  onNewEntry: (entryId: string, subscriptionId: string) => void;
  onSubscriptionDeleted: (subscriptionId: string) => void;

  // Reset operations
  reset: () => void;
  clearPendingEntries: () => void;
}

export const useRealtimeStore = create<RealtimeStore>((set, get) => ({
  readIds: new Set(),
  starredIds: new Set(),
  newEntryIds: new Set(),
  subscriptionCountDeltas: {},
  tagCountDeltas: {},
  pendingEntries: [],
  hasNewEntries: false,

  markRead: (entryId, subscriptionId) =>
    set((state) => {
      // Idempotent: only apply if not already read
      if (state.readIds.has(entryId)) return state;

      return {
        readIds: new Set([...state.readIds, entryId]),
        subscriptionCountDeltas: {
          ...state.subscriptionCountDeltas,
          [subscriptionId]: (state.subscriptionCountDeltas[subscriptionId] || 0) - 1,
        },
      };
    }),

  // ... other actions

  reset: () =>
    set({
      readIds: new Set(),
      starredIds: new Set(),
      newEntryIds: new Set(),
      subscriptionCountDeltas: {},
      tagCountDeltas: {},
      pendingEntries: [],
      hasNewEntries: false,
    }),
}));
```

### 2. Initial Cursor from RSC

**Update `app/(app)/layout.tsx`:**

```tsx
export default function AppLayout({ children }: AppLayoutProps) {
  const initialSyncCursor = new Date().toISOString();

  return (
    <TRPCProvider>
      <AppLayoutContent initialSyncCursor={initialSyncCursor}>{children}</AppLayoutContent>
    </TRPCProvider>
  );
}
```

### 3. Updated SSE Hook

**Modify `useRealtimeUpdates`:**

```tsx
export function useRealtimeUpdates(initialSyncCursor: string) {
  const lastSyncedAtRef = useRef<string>(initialSyncCursor);

  // SSE event handlers push to Zustand
  const handleEvent = useCallback((event: MessageEvent) => {
    // Update cursor from event ID
    if (event.lastEventId) {
      lastSyncedAtRef.current = event.lastEventId;
    }

    const data = parseEventData(event.data);
    if (!data) return;

    // Push to Zustand (no React Query invalidation!)
    if (data.type === "new_entry") {
      useRealtimeStore.getState().onNewEntry(data.entryId, data.subscriptionId);
    }
    // ... other events
  }, []);

  // Polling uses same interface
  const performSync = useCallback(async () => {
    const result = await utils.client.sync.changes.query({
      since: lastSyncedAtRef.current,
    });

    lastSyncedAtRef.current = result.syncedAt;

    // Push to Zustand (same as SSE)
    for (const entry of result.entries.created) {
      useRealtimeStore.getState().onNewEntry(entry.id, entry.subscriptionId);
    }
  }, []);
}
```

### 4. Simplified Mutations

**Update `useEntryMutations`:**

```tsx
export function useEntryMutations() {
  const markReadMutation = trpc.entries.markRead.useMutation({
    onMutate: (variables) => {
      // Just update Zustand
      for (const id of variables.ids) {
        useRealtimeStore.getState().markRead(id /* subscriptionId */);
      }
    },
    onError: (error, variables) => {
      // Rollback by resetting and refetching
      useRealtimeStore.getState().reset();
      utils.entries.list.invalidate();
      toast.error("Failed to mark as read");
    },
  });

  return { markRead: markReadMutation.mutate };
}
```

### 5. Component Updates

**Update Sidebar to merge deltas:**

```tsx
function SubscriptionList() {
  const { data } = trpc.subscriptions.list.useQuery(undefined, {
    staleTime: Infinity,
    refetchOnMount: false,
  });

  const deltas = useRealtimeStore((s) => s.subscriptionCountDeltas);

  const subscriptions = data?.items.map((sub) => ({
    ...sub,
    unreadCount: Math.max(0, sub.unreadCount + (deltas[sub.id] || 0)),
  }));
}
```

**Update EntryList to merge deltas:**

```tsx
function EntryList({ serverEntries }) {
  const readIds = useRealtimeStore((s) => s.readIds);
  const starredIds = useRealtimeStore((s) => s.starredIds);

  const entries = serverEntries.map((entry) => ({
    ...entry,
    read: entry.read || readIds.has(entry.id),
    starred: entry.starred || starredIds.has(entry.id),
  }));
}
```

## Migration Path

### Phase 1: Foundation (Commits 1-3)

1. ✅ Add Zustand dependency
2. ✅ Create Zustand store with delta operations
3. ✅ Add initial sync cursor from RSC layout

### Phase 2: SSE Integration (Commits 4-5)

4. ✅ Update SSE endpoint to send cursors with events
5. ✅ Update `useRealtimeUpdates` to push to Zustand

### Phase 3: Polling Integration (Commit 6)

6. ✅ Update polling to use same Zustand interface

### Phase 4: Mutation Simplification (Commits 7-8)

7. ✅ Simplify `markRead` mutation (server + client)
8. ✅ Simplify `star`/`unstar` mutations

### Phase 5: Component Updates (Commits 9-11)

9. ✅ Update Sidebar to merge deltas
10. ✅ Update EntryList to merge deltas
11. ✅ Update other components (tags, saved articles)

### Phase 6: Cleanup (Commit 12)

12. ✅ Remove old cache manipulation code
13. ✅ Update documentation

## Edge Cases

### Duplicate Events

**Problem**: SSE sends event, then sync also returns same event

**Solution**: Make Zustand operations idempotent using Set tracking

```tsx
markRead: (entryId, subscriptionId) =>
  set((state) => {
    if (state.readIds.has(entryId)) return state; // Already processed
    // ... apply delta
  });
```

### Sync Gap (History Truncated)

**Problem**: Server can only keep 24 hours of sync history

**Solution**: Detect gap and force full refresh

```tsx
if (result.hasMore && result.entries.created.length === 500) {
  // History was truncated
  useRealtimeStore.getState().reset();
  utils.subscriptions.list.invalidate();
  utils.entries.list.invalidate();
}
```

### Infinite Scroll Position

**Problem**: Refetch might disrupt scroll position

**Solution**: React Query preserves scroll on refetch (automatic)

- Component stays mounted
- React Query refetches all loaded pages
- React reconciliation updates in place
- Browser maintains scroll position

**For new entries**: Use "X new entries" button pattern

```tsx
const pendingCount = useRealtimeStore((s) => s.pendingEntries.length);

{
  pendingCount > 0 && (
    <button
      onClick={() => {
        utils.entries.list.invalidate();
        useRealtimeStore.getState().clearPendingEntries();
      }}
    >
      {pendingCount} new entries
    </button>
  );
}
```

### Clock Skew

**Problem**: Client and server clocks differ

**Solution**: Always use server time

- Initial cursor from RSC (server time)
- SSE event IDs from server (server time)
- Sync response includes `syncedAt` (server time)

### Rollback on Error

**Problem**: Mutation fails, need to undo optimistic update

**Solution**: Either per-operation rollback or full reset

```tsx
// Option 1: Track previous state
onMutate: (vars) => {
  const snapshot = useRealtimeStore.getState();
  useRealtimeStore.getState().markRead(...);
  return { snapshot };
},
onError: (err, vars, context) => {
  useRealtimeStore.setState(context.snapshot);
},

// Option 2: Full reset (simpler, works for rare errors)
onError: () => {
  useRealtimeStore.getState().reset();
  utils.entries.list.invalidate();
}
```

## Benefits

### Performance

- **90% reduction in server query complexity** (no count recalculations)
- **Zero refetches during normal usage** (deltas accumulate)
- **Instant UI updates** (Zustand is synchronous)

### Reliability

- **No sync gaps** (cursor from RSC + SSE event IDs)
- **Idempotent operations** (duplicates are safe)
- **Eventual consistency** (deltas correct counts over time)

### Developer Experience

- **~70% less cache manipulation code** (110+ sites → ~30)
- **Simpler mutation logic** (update Zustand, done)
- **Clear separation** (Server = source of truth, Zustand = diff layer)

## Testing Strategy

### Unit Tests

- Zustand store actions (idempotency)
- Delta merge logic (count calculations)

### Integration Tests

- SSE event flow → Zustand → UI
- Polling flow → Zustand → UI
- Mutation → optimistic update → server → UI

### E2E Tests

- Mark read on desktop → sees on phone (SSE)
- SSE drops → polling continues → reconnect → no missed events
- Rapid mutations → counts stay accurate

## Rollback Plan

If issues arise:

1. Feature flag: `ENABLE_ZUSTAND_DELTAS=false`
2. Keep old React Query cache manipulation code
3. Switch between implementations based on flag
4. Gradual rollout to users

## Future Enhancements

### Persistence (Optional)

Store Zustand state in localStorage for offline support:

```tsx
persist(
  (set, get) => ({
    /* store definition */
  }),
  { name: "realtime-store" }
);
```

### Optimistic Entry Creation

Support creating entries optimistically (e.g., email subscriptions):

```tsx
onEntryCreate: (entry) =>
  set((state) => ({
    pendingEntries: [entry, ...state.pendingEntries],
    subscriptionCountDeltas: {
      ...state.subscriptionCountDeltas,
      [entry.subscriptionId]: (state.subscriptionCountDeltas[entry.subscriptionId] || 0) + 1,
    },
  }));
```

### Background Count Reconciliation

Periodically verify counts match server:

```tsx
setInterval(
  () => {
    const serverCounts = await fetchCounts();
    const localCounts = computeLocalCounts();
    if (countsMatch(serverCounts, localCounts)) return;

    // Counts drifted, reset
    useRealtimeStore.getState().reset();
    utils.subscriptions.list.invalidate();
  },
  5 * 60 * 1000
); // Every 5 minutes
```
