# Frontend State Management

This document is the contract for how queries, mutations, and SSE events update the React Query cache. Keep it updated when changing queries/mutations/SSE handling.

## Architecture Overview

The frontend uses React Query (via tRPC) with a hybrid cache update strategy:

| Update Type             | Strategy                   | Rationale                                                           |
| ----------------------- | -------------------------- | ------------------------------------------------------------------- |
| Subscription/tag counts | Direct update (absolute)   | Instant sidebar updates without flicker                             |
| Entry lists             | Direct update (in place)   | Read entries stay visible until navigation; new entries appear live |
| Single entry            | Direct update              | Keyed by ID, easy to target                                         |
| Subscription list       | Direct update (add/remove) | Full data available, avoids refetch                                 |

Entry lists (`entries.list`, `staleTime: Infinity`) are never refetched on a
timer or window focus. Mutations and SSE events patch them in place, and the
single navigation-triggered refresh is `useEntryListRefreshOnNavigate`
(mounted in `AppRouter`): on any pathname change it runs `refreshEntryLists`,
which cancels in-flight fetches on inactive lists (a completing fetch would
clear the staleness flag) and then invalidates every `entries.list` query not
currently fetching — the active one refetches, inactive ones refetch on next
mount. Because the open entry lives in the `?entry=` search param, moving
between a list and an entry in it never changes the pathname and never
refreshes the list (read entries stay visible under the reader). The sidebar
calls the same `refreshEntryLists` when a link matching the current pathname
is clicked, so clicking the current list acts as an explicit refresh.

## Cache Helpers (`src/lib/cache/`)

| File                | Role                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operations.ts`     | High-level operations (primary API): `setCounts`/`setBulkCounts`/`setEntryRelatedCounts` (absolute counts), `handleSubscriptionCreated`/`handleSubscriptionDeleted`, optimistic read/starred updates    |
| `entry-cache.ts`    | Entry list/get patching: `updateEntriesReadStatus`, `updateEntryStarredStatus`, `updateEntryMetadataInCache`, `insertEntryIntoListCaches`, `restoreUnreadEntriesToListCaches`, `findEntryInListCache`   |
| `count-cache.ts`    | Subscription lookup map + tag helpers: `addSubscriptionToCache`, `updateSubscriptionInCache`, `removeSubscriptionFromCache`, `setSubscriptionUnreadCountInMap`, `applySyncTagChanges`, `removeSyncTags` |
| `event-handlers.ts` | `handleSyncEvent` — dispatches SSE/sync events to the operations above                                                                                                                                  |

## Core Queries

| Query                           | Used In                                                    | Notes                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `entries.list` (infinite)       | `EntryList`, `EntryListContainer`, `UnifiedEntriesContent` | Filters: `subscriptionId`, `tagId`, `uncategorized`, `unreadOnly`, `starredOnly`, `sortOrder`, `type`, `limit`. `staleTime: Infinity` |
| `entries.get`                   | `EntryContent`                                             | Single entry with full content                                                                                                        |
| `entries.count`                 | `Sidebar`                                                  | `{}`, `{ type: "saved" }`, or `{ starredOnly: true }` badges                                                                          |
| `subscriptions.list`            | `EntryContent`, `UnifiedEntriesContent`                    | First page as placeholder data                                                                                                        |
| `subscriptions.list` (infinite) | `TagSubscriptionList` (sidebar)                            | `{ tagId }` or `{ uncategorized }`                                                                                                    |
| `tags.list`                     | `Sidebar`, `EditSubscriptionDialog`, `TagManagement`       | All tags with unread + uncategorized counts                                                                                           |

Settings/auth/feature queries (`users.*`, `auth.*`, `apiTokens.list`, `brokenFeeds.list`, `blockedSenders.list`, `ingestAddresses.list`, `imports.get`, `feedStats.list`, `feeds.preview/discover`, `narration.*`, `summarization.isAvailable`) are plain fetch-and-invalidate: their mutations invalidate their own list query and nothing else. They are not part of the realtime contract.

## Mutations

### Entry Mutations (`useEntryMutations`)

| Mutation                   | Cache Updates                                                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entries.markRead`         | Direct: `entries.get`, `entries.list` in place (mark-unread also restores the entry into unreadOnly caches via `restoreUnreadEntriesToListCaches`); absolute counts from the response via `setBulkCounts` |
| `entries.setStarred`       | Exposed as `star`/`unstar` in the hook. Direct: `entries.get`, `entries.list` in place; absolute counts from the response via `setEntryRelatedCounts`                                                     |
| `entries.markAllRead`      | Invalidate: `entries.list`, `subscriptions.list`, `tags.list`, `entries.count` (bulk operation, direct update not practical)                                                                              |
| `entries.fetchFullContent` | Invalidate: `entries.get({ id })`                                                                                                                                                                         |

### Subscription Mutations

| Mutation                | Used In                                  | Cache Updates                                                                                                 |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `subscriptions.create`  | Subscribe page                           | `handleSubscriptionCreated`: add to `subscriptions.list` + set absolute `counts` from response (`onSuccess`)  |
| `subscriptions.update`  | `EntryContent`, `EditSubscriptionDialog` | Invalidate `subscriptions.list`; `EntryContent` also patches `entries.get` for `fetchFullContent` changes     |
| `subscriptions.delete`  | `Sidebar`, Broken feeds                  | Optimistic remove (`onMutate`); set absolute `counts` from response + invalidate `entries.list` (`onSuccess`) |
| `subscriptions.setTags` | `EditSubscriptionDialog`                 | (handled by dialog close)                                                                                     |
| `subscriptions.import`  | `OpmlImportExport`                       | Toast + navigate; `import_progress`/`import_completed` SSE events invalidate `imports.*`                      |

Tag mutations (`tags.create/update/delete`) invalidate/patch via their components; the corresponding SSE events keep other tabs in sync.

## Real-Time Updates

`useRealtimeUpdates` manages the SSE connection (polling fallback via `sync.events`) and feeds every event through `handleSyncEvent`.

**Key principle:** SSE events patch caches directly and must NOT trigger `entries.*` refetches (enforced by e2e tests via `recordTrpcProcedures`). Counts are always set to absolute server-provided values (idempotent — duplicate SSE/sync delivery can't drift them).

| SSE Event              | Cache Updates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new_entry`            | Direct: absolute counts via `setEntryRelatedCounts`; inserts the event's `entry` payload into matching `entries.list` caches via `insertEntryIntoListCaches` (sorted position; tag/uncategorized membership from the cached subscription — conservatively skipped when uncached; skips search/unknown-filter caches and entries beyond the loaded pagination window). Spam entries carry no payload. The catch-up sync path sets `read`/`starred` for entries that changed state on another device; the live path omits them. Idempotent (absolute counts, insert deduped by ID). |
| `entry_updated`        | Direct: `entries.get`, `entries.list` metadata (title, author, summary, url, publishedAt). No invalidation — avoids a race when the entry is open.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `entry_state_changed`  | Direct: `entries.get`, `entries.list` (read, starred); `restoreUnreadEntriesToListCaches` for entries becoming unread; absolute counts via `setBulkCounts`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `subscription_created` | Add to `subscriptions.list`; absolute counts from server `counts` (live path). The sync.events catch-up path omits `counts`, so the client invalidates `tags.list` + `entries.count` instead.                                                                                                                                                                                                                                                                                                                                                                                     |
| `subscription_updated` | Patch subscription in lookup map/list caches; invalidate `tags.list` + `subscriptions.list` (tag membership may have changed).                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `subscription_deleted` | Remove from `subscriptions.list`; absolute counts (live path) or invalidate `tags.list` + `entries.count` (catch-up). Always invalidates `entries.list`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tag_created`          | `applySyncTagChanges` — add to `tags.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tag_updated`          | `applySyncTagChanges` — patch in `tags.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tag_deleted`          | `removeSyncTags` — remove from `tags.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `import_progress`      | Invalidate: `imports.get({ id })`, `imports.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `import_completed`     | Invalidate: `imports.get({ id })`, `imports.list`. Entry/subscription changes arrive as individual events during import.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Optimistic Updates

Optimistic updates do NOT cancel in-flight queries (cancelling can abort content fetches and strand placeholder data). Races are handled by timestamp tracking instead.

### Timestamp-based State Tracking

Entry mutations (markRead, setStarred) track concurrent operations per entry:

1. Each entry tracks how many mutations are in flight
2. As mutations complete, responses are compared by `updatedAt`; the newest wins
3. When all mutations for an entry complete, the winning state is merged into cache only if newer than the cached state

The server's `updatedAt` (`GREATEST(entry.updated_at, user_entry.updated_at)`) determines truth, so parallel get+markRead and out-of-order completion resolve correctly without flicker.

### Auto-mark-read (EntryContent)

Opening an entry fires `entries.get` and (if unread per placeholder data) `markRead` immediately in parallel; the optimistic update shows read state instantly and timestamp tracking resolves whichever completes last.

### subscriptions.delete / create

Delete: `onMutate` removes the subscription from all caches (`removeSubscriptionFromCaches`); `onSuccess` applies server-absolute `counts` and invalidates `entries.list`. Create: `handleSubscriptionCreated` adds to the lookup map and sets absolute counts; the SSE `subscription_created` handler calls the same function (duplicate-safe).

## Mutation Response Shapes

Mutations return everything cache updates need (the client never derives counts locally):

```typescript
// entries.markRead
{
  success: boolean;
  count: number;
  entries: Array<{
    id: string;
    subscriptionId: string | null;
    read: boolean;
    starred: boolean;
    type: "web" | "email" | "saved";
    updatedAt: Date; // cache-freshness comparison
  }>;
  counts: BulkUnreadCounts; // absolute counts for all affected lists
}

// entries.setStarred
{
  entry: {
    id: string;
    read: boolean;
    starred: boolean;
    updatedAt: Date;
  }
  counts: UnreadCounts; // absolute counts for the lists this entry belongs to
}
```

## Key Files

| File                                               | Purpose                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `src/lib/cache/*` (see table above)                | Cache operations, entry/count helpers, SSE event dispatch          |
| `src/lib/hooks/useEntryMutations.ts`               | Entry mutations with optimistic updates + timestamp tracking       |
| `src/lib/hooks/useEntryListRefreshOnNavigate.ts`   | Navigation-triggered entry list invalidation (pathname change)     |
| `src/lib/hooks/useRealtimeUpdates.ts`              | SSE/polling glue feeding the connection machine                    |
| `src/lib/events/connection-state.ts`               | Pure connection state machine (reconnect/backoff/polling fallback) |
| `src/lib/events/cursors.ts`                        | Pure sync-cursor bookkeeping                                       |
| `src/components/entries/EntryListContainer.tsx`    | Stateful entry list container (query, pagination, keyboard nav)    |
| `src/components/entries/UnifiedEntriesContent.tsx` | Unified entry page with navigation and pagination                  |
| `src/components/layout/Sidebar.tsx`                | Subscription delete with optimistic update                         |

## Adding New Cache Updates

1. **Can we update directly?** (full data available, simple key) — Yes → cache helpers in `src/lib/cache/`; No → invalidate.
2. **Entry lists**: patch in place via `entry-cache.ts` helpers; never trigger a refetch from an event — lists refresh on navigation (`useEntryListRefreshOnNavigate`).
3. **Unread counts**: set absolute server-provided counts via `setBulkCounts` / `setEntryRelatedCounts` (idempotent — never deltas).
4. **Handle races**: check existence before add/remove; SSE may deliver the same update as the mutation response.
5. **Update this document** and add unit tests in `tests/unit/frontend/cache/`.
