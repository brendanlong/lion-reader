# Frontend State Management

This document describes the queries, mutations, and cache update patterns used in the frontend. Keep this document updated when modifying queries/mutations to ensure cache consistency.

## Architecture Overview

The frontend uses React Query (via tRPC) for server state management with a hybrid cache update strategy:

- **Queries**: Fetch data from the server
- **Mutations**: Modify data on the server, then update caches (direct updates where possible, invalidation otherwise)
- **SSE/Polling**: Real-time updates via `useRealtimeUpdates` (direct cache updates for subscriptions)
- **Cache Helpers**: Centralized functions in `src/lib/cache/` for consistent cache updates

### Cache Update Strategy

| Update Type             | Strategy                   | Rationale                                       |
| ----------------------- | -------------------------- | ----------------------------------------------- |
| Subscription/tag counts | Direct update              | Instant sidebar updates without flicker         |
| Entry lists             | Invalidation               | Too many filter combinations to update directly |
| Single entry            | Direct update              | Keyed by ID, easy to target                     |
| Subscription list       | Direct update (add/remove) | Full data available, avoids refetch             |

## Cache Helper Functions

Centralized helpers in `src/lib/cache/` ensure consistent updates across the codebase:

### Count Cache (`count-cache.ts`)

| Function                              | Purpose                                                      |
| ------------------------------------- | ------------------------------------------------------------ |
| `calculateTagDeltasFromSubscriptions` | Calculates tag deltas from subscription deltas (collections) |

## Queries

### Entry Queries

| Query                     | Used In                                                     | Filters                                                                                               | Description                    |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------ |
| `entries.list` (infinite) | `EntryList`, `SuspendingEntryList`, `UnifiedEntriesContent` | `subscriptionId`, `tagId`, `uncategorized`, `unreadOnly`, `starredOnly`, `sortOrder`, `type`, `limit` | Paginated entry list           |
| `entries.get`             | `EntryContent`                                              | `{ id }`                                                                                              | Single entry with full content |
| `entries.count`           | `Sidebar`                                                   | `{}`, `{ type: "saved" }`, or `{ starredOnly: true }`                                                 | Unread count for badges        |

### Subscription Queries

| Query                           | Used In                                 | Filters                            | Description                                      |
| ------------------------------- | --------------------------------------- | ---------------------------------- | ------------------------------------------------ |
| `subscriptions.list`            | `EntryContent`, `UnifiedEntriesContent` | None                               | First page of subscriptions for placeholder data |
| `subscriptions.list` (infinite) | `TagSubscriptionList` (sidebar)         | `{ tagId }` or `{ uncategorized }` | Per-tag paginated subscriptions                  |

### Tag Queries

| Query       | Used In                                              | Filters | Description                                             |
| ----------- | ---------------------------------------------------- | ------- | ------------------------------------------------------- |
| `tags.list` | `Sidebar`, `EditSubscriptionDialog`, `TagManagement` | None    | All user tags with unread counts + uncategorized counts |

### Feed Queries

| Query            | Used In        | Filters   | Description                     |
| ---------------- | -------------- | --------- | ------------------------------- |
| `feeds.preview`  | Subscribe page | `{ url }` | Preview feed before subscribing |
| `feeds.discover` | Subscribe page | `{ url }` | Discover feeds on a page        |

### Auth Queries

| Query                 | Used In                                                  | Description               |
| --------------------- | -------------------------------------------------------- | ------------------------- |
| `auth.me`             | `AppLayoutContent`, settings pages, `useRealtimeUpdates` | Current user info         |
| `auth.providers`      | OAuth buttons, `LinkedAccounts`                          | Available OAuth providers |
| `auth.googleAuthUrl`  | `OAuthSignInButton`, `LinkedAccounts`                    | Google OAuth URL          |
| `auth.appleAuthUrl`   | `OAuthSignInButton`, `LinkedAccounts`                    | Apple OAuth URL           |
| `auth.discordAuthUrl` | `OAuthSignInButton`, `LinkedAccounts`                    | Discord OAuth URL         |
| `auth.signupConfig`   | Login/Register pages                                     | Signup configuration      |

### Settings Queries

| Query                        | Used In              | Description            |
| ---------------------------- | -------------------- | ---------------------- |
| `users["me.linkedAccounts"]` | `LinkedAccounts`     | OAuth linked accounts  |
| `users["me.sessions"]`       | Sessions page        | Active sessions        |
| `users["me.preferences"]`    | Email settings page  | User preferences       |
| `apiTokens.list`             | API tokens page      | API tokens             |
| `brokenFeeds.list`           | Broken feeds page    | Broken subscriptions   |
| `blockedSenders.list`        | Blocked senders page | Blocked email senders  |
| `ingestAddresses.list`       | Email settings page  | Email ingest addresses |
| `imports.get`                | `OpmlImportExport`   | Import status          |
| `feedStats.list`             | Feed stats page      | Feed statistics        |

### Feature Queries

| Query                                   | Used In             | Description                        |
| --------------------------------------- | ------------------- | ---------------------------------- |
| `narration.isAiTextProcessingAvailable` | `NarrationSettings` | AI text processing availability    |
| `summarization.isAvailable`             | `EntryContent`      | Article summarization availability |

## Mutations

### Entry Mutations

| Mutation                   | Used In             | Cache Updates                                                                                                                                    |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `entries.markRead`         | `useEntryMutations` | Direct: `entries.get`, `entries.list` (in-place), `subscriptions.list` counts, `tags.list` counts, entry scores. Server returns absolute counts. |
| `entries.markAllRead`      | `useEntryMutations` | Invalidate: `entries.list`, `subscriptions.list`, `tags.list`, `entries.count` (bulk operation, direct update not practical)                     |
| `entries.star`             | `useEntryMutations` | Direct: `entries.get`, `entries.list` (in-place), `entries.count({ starredOnly: true })`, entry scores. Server returns absolute counts.          |
| `entries.unstar`           | `useEntryMutations` | Direct: `entries.get`, `entries.list` (in-place), `entries.count({ starredOnly: true })`, entry scores. Server returns absolute counts.          |
| `entries.setScore`         | `useEntryMutations` | Direct: `entries.get`, `entries.list` (in-place), entry scores                                                                                   |
| `entries.fetchFullContent` | `EntryContent`      | Invalidate: `entries.get({ id })`                                                                                                                |

### Subscription Mutations

| Mutation                | Used In                                  | Cache Updates                                                                         |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `subscriptions.create`  | Subscribe page                           | Direct cache update via `setData`                                                     |
| `subscriptions.update`  | `EntryContent`, `EditSubscriptionDialog` | Invalidate: `subscriptions.list`                                                      |
| `subscriptions.delete`  | `Sidebar`, Broken feeds                  | Optimistic: remove from `subscriptions.list`. Invalidate: `entries.list`, `tags.list` |
| `subscriptions.setTags` | `EditSubscriptionDialog`                 | (handled by dialog close)                                                             |
| `subscriptions.import`  | `OpmlImportExport`                       | Toast + navigate on success                                                           |

### Tag Mutations

| Mutation      | Used In         | Invalidates            |
| ------------- | --------------- | ---------------------- |
| `tags.create` | `TagManagement` | (handled by component) |
| `tags.update` | `TagManagement` | (handled by component) |
| `tags.delete` | `TagManagement` | (handled by component) |

### Settings Mutations

| Mutation                        | Used In              | Invalidates           |
| ------------------------------- | -------------------- | --------------------- |
| `users["me.setPassword"]`       | Settings page        | Toast + clear form    |
| `users["me.changePassword"]`    | Settings page        | Toast + redirect      |
| `users["me.revokeSession"]`     | Sessions page        | Sessions list         |
| `users["me.updatePreferences"]` | Email settings       | Preferences           |
| `apiTokens.create`              | API tokens page      | Token list            |
| `apiTokens.revoke`              | API tokens page      | Token list            |
| `brokenFeeds.retryFetch`        | Broken feeds page    | Broken feeds list     |
| `blockedSenders.unblock`        | Blocked senders page | Blocked senders list  |
| `ingestAddresses.create`        | Email settings       | Ingest addresses list |
| `ingestAddresses.update`        | Email settings       | Ingest addresses list |
| `ingestAddresses.delete`        | Email settings       | Ingest addresses list |

### Content Mutations

| Mutation                 | Used In            | Invalidates             |
| ------------------------ | ------------------ | ----------------------- |
| `saved.save`             | Save page          | (navigation on success) |
| `saved.uploadFile`       | `FileUploadButton` | (handled by caller)     |
| `narration.generate`     | `useNarration`     | (returns audio)         |
| `summarization.generate` | `EntryContent`     | (local state update)    |

## Real-Time Updates

The `useRealtimeUpdates` hook manages SSE connections and updates caches.

**Key principle:** Direct cache updates where possible, invalidation only when necessary. `entries.list` is NOT invalidated for new entries - users see new entries when they navigate (sidebar counts update immediately).

| SSE Event              | Cache Updates                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new_entry`            | Direct: `subscriptions.list` unreadCount, `tags.list` unreadCount, `entries.count`. Does NOT invalidate `entries.list`.                           |
| `entry_updated`        | Direct: `entries.get`, `entries.list` (metadata: title, author, summary, url, publishedAt). No invalidation - avoids race condition when viewing. |
| `subscription_created` | Direct: add to `subscriptions.list`, update `tags.list` feedCount/unreadCount, update `entries.count`.                                            |
| `subscription_deleted` | Direct: remove from `subscriptions.list`, update `tags.list`, update `entries.count`. Invalidate: `entries.list`.                                 |
| `import_progress`      | Invalidate: `imports.get({ id })`, `imports.list`                                                                                                 |
| `import_completed`     | Invalidate: `imports.get({ id })`, `imports.list`. Entry/subscription updates handled by individual events during import.                         |

## Optimistic Updates

Some mutations use optimistic updates for better UX.

**Important:** Optimistic updates do NOT cancel in-flight queries. Cancelling queries can abort content fetches, leaving components stuck with placeholder data. If a query completes with stale data while a mutation is pending, the mutation tracking system handles the race correctly.

### Timestamp-based State Tracking

Entry mutations (markRead, setStarred) use timestamp-based tracking to handle concurrent operations:

1. **Pending count tracking:** Each entry tracks how many mutations are currently in flight
2. **Winning state:** As mutations complete, their responses are compared by `updatedAt` timestamp; the newest wins
3. **Cache merge:** When all mutations for an entry complete, the winning state is merged into cache only if it's newer than the current cache state

This allows:

- **Parallel operations:** Get query and mark-read mutation can run simultaneously
- **No flickering:** Out-of-order completion doesn't cause UI state changes
- **Race resolution:** The server's `updatedAt` (computed as `GREATEST(entry.updated_at, user_entry.updated_at)`) determines truth

### Auto-mark-read (EntryContent)

When opening an entry, the mark-read mutation fires immediately in parallel with the `entries.get` query:

1. Entry mounts, fires `entries.get` query
2. If entry is unread (from placeholder data), immediately fires `markRead` mutation
3. Optimistic update shows entry as read instantly
4. Both requests complete in any order; timestamp tracking ensures correct final state

This is simpler than the old two-phase approach and provides better latency.

### subscriptions.delete (Sidebar)

Uses full optimistic update with rollback:

```typescript
onMutate: (variables) => {
  // Cancel in-flight queries
  await utils.subscriptions.list.cancel();
  // Snapshot for rollback
  const previousData = utils.subscriptions.list.getData();
  // Optimistically remove
  utils.subscriptions.list.setData(undefined, (old) => ({
    ...old,
    items: old.items.filter((item) => item.id !== variables.id),
  }));
  return { previousData };
},
onError: (_, __, context) => {
  // Rollback on error
  utils.subscriptions.list.setData(undefined, context.previousData);
},
```

### subscriptions.create (Subscribe page)

Uses manual cache update to avoid race conditions with SSE:

```typescript
onSuccess: (data) => {
  utils.subscriptions.list.setData(undefined, (old) => {
    // Check for duplicates from SSE
    if (old.items.some((s) => s.id === data.subscription.id)) return old;
    return { ...old, items: [...old.items, formattedSubscription] };
  });
};
```

## Server Response Enhancements

Mutations return context needed for cache updates. The server provides all necessary state so the client doesn't need to look up data from the cache (which would be fragile).

### entries.markRead

Returns entries with all context needed for cache updates:

```typescript
// Response
{
  success: boolean;
  count: number;
  entries: Array<{
    id: string;
    subscriptionId: string | null; // For subscription/tag count updates
    starred: boolean; // For starred unread count updates
    type: "web" | "email" | "saved"; // For saved count updates
    updatedAt: Date; // For timestamp-based cache freshness comparison
    score: number | null; // Explicit score for display
    implicitScore: number; // Implicit score from actions (star, mark-unread, mark-read-on-list)
  }>;
}
```

### entries.star / entries.unstar

Returns the updated entry with read status and scores:

```typescript
// Response
{
  entry: {
    id: string;
    read: boolean; // For starred unread count updates
    starred: boolean;
    updatedAt: Date; // For timestamp-based cache freshness comparison
    score: number | null; // Explicit score for display
    implicitScore: number; // Implicit score (starring sets hasStarred = implicit +2)
  }
}
```

### entries.setScore

Returns the updated entry with score fields:

```typescript
// Response
{
  entry: {
    id: string;
    read: boolean;
    starred: boolean;
    updatedAt: Date; // For timestamp-based cache freshness comparison
    score: number | null; // Explicit score (-2 to +2, or null to clear)
    implicitScore: number; // Implicit score from actions
  }
}
```

## Key Files

| File                                               | Purpose                                           |
| -------------------------------------------------- | ------------------------------------------------- |
| `src/lib/cache/operations.ts`                      | High-level cache operations (primary API)         |
| `src/lib/cache/count-cache.ts`                     | Tag delta calculation from subscription deltas    |
| `src/lib/hooks/useEntryMutations.ts`               | Entry mutations with cache updates                |
| `src/lib/hooks/useRealtimeUpdates.ts`              | SSE connection and cache updates                  |
| `src/lib/hooks/useKeyboardShortcuts.ts`            | Keyboard navigation and entry selection           |
| `src/components/entries/UnifiedEntriesContent.tsx` | Unified entry page with navigation and pagination |
| `src/components/entries/SuspendingEntryList.tsx`   | Entry list wrapper with Suspense and pagination   |
| `src/components/layout/Sidebar.tsx`                | Subscription delete with optimistic update        |
| `src/components/entries/EntryContent.tsx`          | Entry display with mutations                      |
| `src/components/entries/EntryList.tsx`             | Entry list with infinite scroll                   |

## Adding New Cache Updates

When adding cache updates, follow this decision tree:

1. **Can we update directly?** (full data available, simple key)
   - Yes → Use cache helpers in `src/lib/cache/`
   - No → Invalidate the query

2. **What caches are affected?**
   - Entry lists: Invalidate (too many filter combinations)
   - Entry counts: Direct update via `adjustEntriesCount`
   - Subscription counts: Direct update via `adjustSubscriptionUnreadCounts`
   - Tag counts: Direct update via `adjustTagUnreadCounts` + `calculateTagDeltasFromSubscriptions`
   - Single entry: Direct update via `setData`

3. **Handle race conditions:**
   - Check if data already exists before adding
   - Check if data already removed before removing
   - SSE may deliver the same update as the mutation response

4. **Update this document** with the new pattern
