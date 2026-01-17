# Frontend State Management

This document describes the queries, mutations, and cache invalidation patterns used in the frontend. Keep this document updated when modifying queries/mutations to ensure cache consistency.

## Architecture Overview

The frontend uses React Query (via tRPC) for server state management with cache invalidation for data synchronization:

- **Queries**: Fetch data from the server
- **Mutations**: Modify data on the server, then invalidate relevant caches
- **SSE/Polling**: Real-time updates trigger cache invalidations via `useRealtimeUpdates`

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

| Mutation                   | Used In             | Invalidates                                                                               |
| -------------------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `entries.markRead`         | `useEntryMutations` | `entries.list`, `entries.count`, `subscriptions.list`, `tags.list`                        |
| `entries.markAllRead`      | `useEntryMutations` | `entries.list`, `subscriptions.list`, `tags.list`, `entries.count({ starredOnly: true })` |
| `entries.star`             | `useEntryMutations` | `entries.list({ starredOnly: true })`, `entries.count({ starredOnly: true })`             |
| `entries.unstar`           | `useEntryMutations` | `entries.list({ starredOnly: true })`, `entries.count({ starredOnly: true })`             |
| `entries.fetchFullContent` | `EntryContent`      | `entries.get({ id })`                                                                     |

### Subscription Mutations

| Mutation                | Used In                                  | Invalidates                                                   |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| `subscriptions.create`  | Subscribe page                           | Manual cache update via `setData`                             |
| `subscriptions.update`  | `EntryContent`, `EditSubscriptionDialog` | `subscriptions.list`                                          |
| `subscriptions.delete`  | `Sidebar`, Broken feeds                  | Optimistic update, then `entries.list`, `tags.list` on settle |
| `subscriptions.setTags` | `EditSubscriptionDialog`                 | (handled by dialog close)                                     |
| `subscriptions.import`  | `OpmlImportExport`                       | Toast + navigate on success                                   |

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

The `useRealtimeUpdates` hook manages SSE connections and triggers cache invalidations:

| SSE Event               | Invalidates                                                           |
| ----------------------- | --------------------------------------------------------------------- |
| `new_entry`             | `entries.list`, `subscriptions.list`, `tags.list`                     |
| `entry_updated`         | `entries.get({ id })`                                                 |
| `subscription_created`  | `subscriptions.list`, `tags.list`                                     |
| `subscription_deleted`  | `subscriptions.list`, `entries.list`, `tags.list`                     |
| `saved_article_created` | `entries.list({ type: "saved" })`, `entries.count({ type: "saved" })` |
| `saved_article_updated` | `entries.get({ id })`, `entries.list({ type: "saved" })`              |
| `import_progress`       | `imports.get({ id })`, `imports.list`                                 |
| `import_completed`      | `imports.get({ id })`, `imports.list`, `entries.list`                 |

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

## Key Files

| File                                      | Purpose                                          |
| ----------------------------------------- | ------------------------------------------------ |
| `src/lib/hooks/useEntryMutations.ts`      | Entry mutations with invalidation                |
| `src/lib/hooks/useRealtimeUpdates.ts`     | SSE connection and cache invalidation            |
| `src/lib/hooks/useEntryListQuery.ts`      | Infinite query with navigation                   |
| `src/lib/hooks/useEntryPage.ts`           | Higher-order hook combining all entry page logic |
| `src/components/layout/Sidebar.tsx`       | Subscription delete with optimistic update       |
| `src/components/entries/EntryContent.tsx` | Entry display with mutations                     |
| `src/components/entries/EntryList.tsx`    | Entry list with infinite scroll                  |

## Adding New Cache Updates

When adding direct cache updates (without full refetch), ensure:

1. **Update this document** with the new invalidation pattern
2. **Consider all affected queries** - a change to entries may affect subscription counts
3. **Handle race conditions** - SSE may deliver the same update
4. **Implement rollback** for optimistic updates
5. **Test offline/error scenarios** to ensure cache consistency

## Future Improvements

The current architecture uses simple cache invalidation. For better perceived performance, consider:

1. **Direct cache updates** on mutations (update cached data directly instead of invalidating)
2. **Optimistic updates** for more operations (star, read status)
3. **Granular invalidation** (only invalidate specific cache entries)

When implementing these, this document should be updated to reflect the new patterns.
