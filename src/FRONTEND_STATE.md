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

### Entry Cache (`entry-cache.ts`)

| Function                   | Purpose                                                  |
| -------------------------- | -------------------------------------------------------- |
| `updateEntriesReadStatus`  | Updates `entries.get` cache + invalidates `entries.list` |
| `updateEntryStarredStatus` | Updates `entries.get` cache + invalidates `entries.list` |

### Count Cache (`count-cache.ts`)

| Function                              | Purpose                                                |
| ------------------------------------- | ------------------------------------------------------ |
| `adjustSubscriptionUnreadCounts`      | Directly updates unread counts in `subscriptions.list` |
| `adjustTagUnreadCounts`               | Directly updates unread counts in `tags.list`          |
| `adjustEntriesCount`                  | Directly updates `entries.count` cache                 |
| `addSubscriptionToCache`              | Adds new subscription to `subscriptions.list`          |
| `removeSubscriptionFromCache`         | Removes subscription from `subscriptions.list`         |
| `calculateTagDeltasFromSubscriptions` | Calculates tag deltas from subscription deltas         |

## Queries

### Entry Queries

| Query                     | Used In                                          | Filters                                                                                               | Description                    |
| ------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------ |
| `entries.list` (infinite) | `EntryList`, `useEntryListQuery`, `useEntryPage` | `subscriptionId`, `tagId`, `uncategorized`, `unreadOnly`, `starredOnly`, `sortOrder`, `type`, `limit` | Paginated entry list           |
| `entries.get`             | `EntryContent`                                   | `{ id }`                                                                                              | Single entry with full content |
| `entries.count`           | `Sidebar`                                        | `{ type: "saved" }` or `{ starredOnly: true }`                                                        | Unread count for badges        |

### Subscription Queries

| Query                | Used In                                                | Filters | Description                               |
| -------------------- | ------------------------------------------------------ | ------- | ----------------------------------------- |
| `subscriptions.list` | `Sidebar`, `EntryContent`, `useEntryPage`, entry pages | None    | All user subscriptions with unread counts |

### Tag Queries

| Query       | Used In                                              | Filters | Description                      |
| ----------- | ---------------------------------------------------- | ------- | -------------------------------- |
| `tags.list` | `Sidebar`, `EditSubscriptionDialog`, `TagManagement` | None    | All user tags with unread counts |

### Feed Queries

| Query            | Used In        | Filters   | Description                     |
| ---------------- | -------------- | --------- | ------------------------------- |
| `feeds.preview`  | Subscribe page | `{ url }` | Preview feed before subscribing |
| `feeds.discover` | Subscribe page | `{ url }` | Discover feeds on a page        |

### Auth Queries

| Query                | Used In                                                  | Description               |
| -------------------- | -------------------------------------------------------- | ------------------------- |
| `auth.me`            | `AppLayoutContent`, settings pages, `useRealtimeUpdates` | Current user info         |
| `auth.providers`     | OAuth buttons, `LinkedAccounts`                          | Available OAuth providers |
| `auth.googleAuthUrl` | `GoogleSignInButton`, `LinkedAccounts`                   | Google OAuth URL          |
| `auth.appleAuthUrl`  | `AppleSignInButton`, `LinkedAccounts`                    | Apple OAuth URL           |
| `auth.signupConfig`  | Login/Register pages                                     | Signup configuration      |

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

| Mutation                   | Used In             | Cache Updates                                                                                                                         |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `entries.markRead`         | `useEntryMutations` | Direct: `entries.get`, `subscriptions.list` counts, `tags.list` counts. Invalidate: `entries.list`                                    |
| `entries.markAllRead`      | `useEntryMutations` | Invalidate: `entries.list`, `subscriptions.list`, `tags.list`, `entries.count({ starredOnly: true })` (bulk operation, count unknown) |
| `entries.star`             | `useEntryMutations` | Direct: `entries.get`, `entries.count({ starredOnly: true })`. Invalidate: `entries.list`                                             |
| `entries.unstar`           | `useEntryMutations` | Direct: `entries.get`, `entries.count({ starredOnly: true })`. Invalidate: `entries.list`                                             |
| `entries.fetchFullContent` | `EntryContent`      | Invalidate: `entries.get({ id })`                                                                                                     |

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

The `useRealtimeUpdates` hook manages SSE connections and updates caches:

| SSE Event               | Cache Updates                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `new_entry`             | Invalidate: `entries.list`, `subscriptions.list`, `tags.list` (full entry data not in event)               |
| `entry_updated`         | Invalidate: `entries.get({ id })`                                                                          |
| `subscription_created`  | Direct: add to `subscriptions.list`. Invalidate: `tags.list`                                               |
| `subscription_deleted`  | Direct: remove from `subscriptions.list` (if not already removed). Invalidate: `entries.list`, `tags.list` |
| `saved_article_created` | Invalidate: `entries.list({ type: "saved" })`, `entries.count({ type: "saved" })`                          |
| `saved_article_updated` | Invalidate: `entries.get({ id })`, `entries.list({ type: "saved" })`                                       |
| `import_progress`       | Invalidate: `imports.get({ id })`, `imports.list`                                                          |
| `import_completed`      | Invalidate: `imports.get({ id })`, `imports.list`, `entries.list`                                          |

## Optimistic Updates

Some mutations use optimistic updates for better UX:

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
  }>;
}
```

### entries.star / entries.unstar

Returns the updated entry with read status:

```typescript
// Response
{
  entry: {
    id: string;
    read: boolean; // For starred unread count updates
    starred: boolean;
  }
}
```

## Key Files

| File                                      | Purpose                                          |
| ----------------------------------------- | ------------------------------------------------ |
| `src/lib/cache/index.ts`                  | Cache helper exports                             |
| `src/lib/cache/operations.ts`             | High-level cache operations (primary API)        |
| `src/lib/cache/entry-cache.ts`            | Low-level entry cache update helpers             |
| `src/lib/cache/count-cache.ts`            | Low-level subscription/tag count update helpers  |
| `src/lib/hooks/useEntryMutations.ts`      | Entry mutations with cache updates               |
| `src/lib/hooks/useRealtimeUpdates.ts`     | SSE connection and cache updates                 |
| `src/lib/hooks/useEntryListQuery.ts`      | Infinite query with navigation                   |
| `src/lib/hooks/useEntryPage.ts`           | Higher-order hook combining all entry page logic |
| `src/components/layout/Sidebar.tsx`       | Subscription delete with optimistic update       |
| `src/components/entries/EntryContent.tsx` | Entry display with mutations                     |
| `src/components/entries/EntryList.tsx`    | Entry list with infinite scroll                  |

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
