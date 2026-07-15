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

**`fetchNextPage` clobber guard (#1081):** React Query's `infiniteQueryBehavior`
snapshots the existing pages when a `fetchNextPage` starts and, on completion,
replaces the data with `snapshot + newPage` — silently dropping any
`setQueryData` applied to the old pages mid-fetch. j/k navigation triggers this
(opening an entry near the end auto-marks it read at the same moment
`fetchNextPage` fires), so the completing fetch would revert the entry to unread.
Every next-page fetch (keyboard- and scroll-triggered, in both
`EntryListContainer` and `UnifiedEntriesContent`) therefore calls
`snapshotEntryGetStates` **before** starting the fetch and
`reconcileListFromChangedEntryGets` **after** it settles, re-asserting onto the
list only the entries whose `entries.get` read/starred state **changed during
the fetch window**. It is a diff, not a blanket re-assert, because `entries.get`
is not universally in lockstep with the list — `mark_all_read` invalidates
`entries.list` but never touches `entries.get`, so a blanket re-assert would
resurrect a stale get (e.g. a prefetched-unread entry that mark-all-read marked
read) into the freshly-refetched list. A clobber can only affect writes made
after the fetch started, so restricting to mid-fetch changes captures exactly
those. (A brand-new SSE-inserted entry has no `entries.get` entry and can't be
restored this way; it reappears on the next navigation refresh.)

## Cache Helpers (`src/lib/cache/`)

| File                | Role                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operations.ts`     | High-level operations (primary API): `setCounts`/`setBulkCounts`/`setEntryRelatedCounts` (absolute counts), `handleSubscriptionCreated`/`handleSubscriptionDeleted`, optimistic read/starred updates    |
| `entry-cache.ts`    | Entry list/get patching: `updateEntriesReadStatus`, `updateEntryStarredStatus`, `updateEntryMetadataInCache`, `insertEntryIntoListCaches`, `restoreUnreadEntriesToListCaches`, `findEntryInListCache`   |
| `count-cache.ts`    | Subscription lookup map + tag helpers: `addSubscriptionToCache`, `updateSubscriptionInCache`, `removeSubscriptionFromCache`, `setSubscriptionUnreadCountInMap`, `applySyncTagChanges`, `removeSyncTags` |
| `event-handlers.ts` | `handleSyncEvent` — dispatches SSE/sync events to the operations above                                                                                                                                  |

## Core Queries

| Query                           | Used In                                                    | Notes                                                                                                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `entries.list` (infinite)       | `EntryList`, `EntryListContainer`, `UnifiedEntriesContent` | Filters: `subscriptionId`, `tagId`, `uncategorized`, `unreadOnly`, `starredOnly`, `sortOrder`, `sortBy` (`"published"` \| `"readChanged"`), `type`, `excludeTypes`, `query` (full-text search), `limit`. `staleTime: Infinity` |
| `entries.get`                   | `EntryContent`                                             | Single entry with full content (includes `fetchFullContent`, so no separate subscription query needed)                                                                                                                         |
| `subscriptions.get`             | `UnifiedEntriesContent`                                    | Resolves the route/reader title for `/subscription/[id]`; falls back to the sidebar list cache until it resolves                                                                                                               |
| `entries.count`                 | `Sidebar`                                                  | `{}`, `{ type: "saved" }`, or `{ starredOnly: true }` badges                                                                                                                                                                   |
| `subscriptions.list` (infinite) | `TagSubscriptionList` (sidebar)                            | The sidebar per-tag / per-uncategorized subscription list (`{ tagId }` or `{ uncategorized }`). This is the only remaining consumer of `subscriptions.list`.                                                                   |
| `tags.list`                     | `Sidebar`, `EditSubscriptionDialog`, `TagManagement`       | All tags with unread + uncategorized counts                                                                                                                                                                                    |

`sortBy: "readChanged"` backs the `/recently-read` view (entries sorted by `read_changed_at` rather than publish time; defaults to `unreadOnly=false`). Its cache and the search (`query`) caches are **not** patched by SSE `new_entry` inserts: `insertEntryIntoListCaches` (`src/lib/cache/entry-cache.ts`) skips any list cache whose input has a `query` or a `sortBy` other than `"published"`, because their ordering (relevance rank / read-time) can't be derived from a new entry's fields. Those views instead refresh on navigation like any other list.

**Search is temporarily disabled (#1249)** — there is no database index for full-text search, so until the stored tsvector column + GIN index land, `ENTRY_SEARCH_ENABLED` (`src/lib/feature-flags.ts`) is `false`: `parseViewPreferencesFromParams` ignores `?q=` (so `query` is never set and deep links render the plain list), the search toggle/bar and `/` shortcut are hidden, and `listEntries` rejects any `query` that reaches it. The wiring described below is kept intact for re-enablement.

`query` backs the entry search UI (#565): the `?q=` URL param (set by the search bar in `EntryPageLayout`, opened via the header toggle or `/`) flows through `parseViewPreferencesFromParams` → `buildEntriesListInput` → `useEntriesListInput`, so search results reuse the same `entries.list` infinite-query machinery scoped to the current view's filters, and `EntryListPage` prefetches them server-side for `?q=` deep links. While a `q` is present, the `unreadOnly` **default** flips to `false` (a search is usually for something already read; the toggle still works) and `sortOrder`/`direction` are canonicalized to `"newest"`/`"forward"` in the input (the backend ranks search results by relevance and ignores sort order — a lingering `?sort=` param must not fragment the cache key).

## Mutations

### Entry Mutations (`useEntryMutations`)

| Mutation                   | Cache Updates                                                                                                                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entries.markRead`         | Direct: `entries.get`, `entries.list` in place (mark-unread also restores the entry into unreadOnly caches via `restoreUnreadEntriesToListCaches`); absolute counts from the response via `setBulkCounts`                                                               |
| `entries.setStarred`       | Exposed as `star`/`unstar` in the hook. Direct: `entries.get`, `entries.list` in place; absolute counts from the response via `setEntryRelatedCounts`                                                                                                                   |
| `entries.markAllRead`      | Invalidate: `entries.list`, `subscriptions.list`, `tags.list`, `entries.count` (bulk operation, direct update not practical). The server also publishes one `mark_all_read` SSE event so other tabs/devices invalidate the same caches without waiting for a sync poll. |
| `entries.fetchFullContent` | Direct: patch `entries.get({ id })` with the returned `result.entry` via `utils.entries.get.setData` (in `EntryContent`). Only when the response has no `entry` does it fall back to `invalidate({ id })`.                                                              |

### Subscription Mutations

| Mutation                | Used In                                  | Cache Updates                                                                                                 |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `subscriptions.create`  | Subscribe page                           | `handleSubscriptionCreated`: add to `subscriptions.list` + set absolute `counts` from response (`onSuccess`)  |
| `subscriptions.update`  | `EntryContent`, `EditSubscriptionDialog` | Invalidate `subscriptions.list`; `EntryContent` also patches `entries.get` for `fetchFullContent` changes     |
| `subscriptions.delete`  | `Sidebar`, Broken feeds                  | Optimistic remove (`onMutate`); set absolute `counts` from response + invalidate `entries.list` (`onSuccess`) |
| `subscriptions.setTags` | `EditSubscriptionDialog`                 | (handled by dialog close)                                                                                     |
| `subscriptions.import`  | `OpmlImportExport`                       | Toast + navigate; `import_progress`/`import_completed` SSE events invalidate `imports.*`                      |

Tag mutations (`tags.create/update/delete`) invalidate/patch via their components; the corresponding SSE events keep other tabs in sync.

**No-op re-saves publish nothing (issue #1160):** `subscriptions.update` with an identical `customTitle`/`fetchFullContent`, and `subscriptions.setTags` with the identical tag set, do not emit `subscription_updated` and do not bump `subscriptions.updated_at` (so the `sync.events` subscription cursor doesn't move). Other tabs therefore only see `subscription_updated` for genuine changes — the acting tab still updates its own cache via the mutation response/invalidation as listed above. This mirrors the entry-level "row written vs. value flipped" rule (issue #1118; see "Row Written vs. Value Flipped" in src/server/CLAUDE.md).

## Real-Time Updates

`useRealtimeUpdates` manages the SSE connection (polling fallback via `sync.events`) and feeds every event through `handleSyncEvent`.

**Key principle:** SSE events patch caches directly and must NOT trigger `entries.*` refetches (enforced by e2e tests via `recordTrpcProcedures`). Counts are always set to absolute server-provided values (idempotent — duplicate SSE/sync delivery can't drift them). The **one deliberate exception** is `mark_all_read`: mark-all-read is unbounded, so patching every entry (or shipping every id) isn't worth it, and the event invalidates `entries.list` instead — refetching a list the user just cleared is an acceptable rare cost.

**Catch-up sync after (re)connect (#1081):** on SSE `open`, `useRealtimeUpdates` runs a catch-up sync against `sync.events` from the current cursors. Two invariants keep it from losing changes made while disconnected:

- **Retry on failure.** A failed catch-up sync is retried with exponential backoff (2s→30s) even in the `connected` phase (the `polling` phase already retries every 30s). A single failure used to be swallowed as "done", stranding the gap forever on an idle view.
- **Cursor freeze until caught up.** Live SSE events patch the cache immediately but do **not** advance the persisted sync cursor until the connection's catch-up sync has fully succeeded (`caughtUpRef`). Otherwise a live event would push the cursor past the not-yet-synced gap, making the pending/retrying catch-up query skip the gap's rows. The catch-up sync itself always advances the cursor (it drains the authoritative server sequence). Any stream error (including the browser's silent EventSource auto-reconnect) re-freezes the cursor so the next catch-up re-covers whatever was missed.

| SSE Event              | Cache Updates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new_entry`            | Direct: absolute counts via `setEntryRelatedCounts`; inserts the event's `entry` payload into matching `entries.list` caches via `insertEntryIntoListCaches` (sorted position; tag/uncategorized membership from the cached subscription — conservatively skipped when uncached; skips search/unknown-filter caches and entries beyond the loaded pagination window). Spam entries carry no payload. The catch-up sync path sets `read`/`starred` for entries that changed state on another device; the live path omits them. Idempotent (absolute counts, insert deduped by ID). |
| `entry_updated`        | Direct: `entries.get`, `entries.list` metadata (title, author, summary, url, publishedAt). No invalidation — avoids a race when the entry is open.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `entry_state_changed`  | Direct: `entries.get`, `entries.list` (read, starred); absolute counts via `setBulkCounts`. Entries becoming unread are inserted into the list caches missing them: events for unread flips carry a list-item payload (like `new_entry`; omitted for spam) inserted via `insertEntryIntoListCaches` — so the entry appears even when no cached list holds a copy (marked unread on another device/MCP, issue #1237); payload-less events (older servers, star/unstar of an unread entry) fall back to `restoreUnreadEntriesToListCaches` (another cached list's copy).            |
| `mark_all_read`        | A `markAllRead` happened on another tab/device. Invalidate `entries.list`, `entries.count`, `tags.list`, `subscriptions.list` — the same thing the acting tab does on success. This is the **one** SSE event that deliberately refetches `entries.list`: mark-all-read is unbounded, so patching every entry (or shipping every id) isn't worth it, and refetching a list the user just cleared is an acceptable, rare cost. Advances the entries cursor so a reconnect catch-up doesn't re-deliver every marked entry.                                                           |
| `subscription_created` | Add to `subscriptions.list`; absolute counts from server `counts` (live path). The sync.events catch-up path omits `counts`, so the client invalidates `tags.list` + `entries.count` instead.                                                                                                                                                                                                                                                                                                                                                                                     |
| `subscription_updated` | Patch subscription in lookup map/list caches; invalidate `tags.list` + `subscriptions.list` (tag membership may have changed).                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `subscription_deleted` | Remove from `subscriptions.list`; absolute counts (live path) or invalidate `tags.list` + `entries.count` (catch-up). The count update **and** `entries.list` invalidation always run — even when the subscription isn't cached (optimistically removed, or never loaded with tags collapsed); only the structural removal is gated on the subscription being cached (#1081).                                                                                                                                                                                                     |
| `tag_created`          | `applySyncTagChanges` — add to `tags.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tag_updated`          | `applySyncTagChanges` — patch in `tags.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tag_deleted`          | `removeSyncTags` — remove from `tags.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `import_progress`      | Invalidate: `imports.get({ id })`, `imports.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `import_completed`     | Invalidate: `imports.get({ id })`, `imports.list`. Entry/subscription changes arrive as individual events during import.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `announcement_changed` | **Global broadcast** (site-status channel, not per-user): the admin changed the announcement banner. No React Query cache is touched — it calls `setLiveAnnouncement` (`@/lib/site-status/announcement-store`), a module store the root-layout `AnnouncementBanner` subscribes to via `useSyncExternalStore`. `announcement` is null when disabled/cleared (hides the banner). Not part of the `sync.events` catch-up (SSE-only), so a change during a disconnect is picked up on the next full page load.                                                                        |

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
  counts?: BulkUnreadCounts; // absolute counts for all affected lists
}

// entries.setStarred
{
  entry: {
    id: string;
    read: boolean;
    starred: boolean;
    updatedAt: Date;
  }
  counts?: UnreadCounts; // absolute counts for the lists this entry belongs to
}
```

`counts` is **absent when no value actually flipped** (a same-value re-assert —
e.g. marking an already-read entry read again — writes the row to advance the
last-write-wins watermark but changes nothing the user can see, so the server
skips the count aggregation; issue #1118). The `onSuccess` handlers apply counts
only when present; absent counts mean the cached counts are already correct. The
same rule gates the server's `entry_state_changed` SSE publish, so re-asserts
emit no event at all.

**Meaningful change vs. row touched** (issue #1118 Part 2): the offline/polling
**delta-sync** path (`sync.events`, and Wallabag `since`) is driven by
`visible_entries.updated_at = GREATEST(entries.updated_at, user_entries.updated_at)`,
which is a **separate signal** from the `read_changed_at`/`starred_changed_at`
last-write-wins watermarks. A same-value re-assert advances the watermark (so
last-writer-wins stays correct) but the mark-read/star UPDATEs only bump
`user_entries.updated_at` when the value actually flips. So a re-assert doesn't
churn delta sync either — an offline client re-syncing after a resync-style
re-mark won't re-fetch entries whose visible state is unchanged. Genuine flips
bump `updated_at` and re-deliver as before.

## Key Files

| File                                               | Purpose                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `src/lib/cache/*` (see table above)                | Cache operations, entry/count helpers, SSE event dispatch           |
| `src/lib/hooks/useEntryMutations.ts`               | Entry mutations with optimistic updates + timestamp tracking        |
| `src/lib/hooks/useEntryListRefreshOnNavigate.ts`   | Navigation-triggered entry list invalidation (pathname change)      |
| `src/lib/hooks/useRealtimeUpdates.ts`              | SSE/polling glue feeding the connection machine                     |
| `src/lib/events/connection-state.ts`               | Pure connection state machine (reconnect/backoff/polling fallback)  |
| `src/lib/events/cursors.ts`                        | Pure sync-cursor bookkeeping                                        |
| `src/components/entries/EntryListContainer.tsx`    | Stateful entry list container (query, pagination, keyboard nav)     |
| `src/components/entries/UnifiedEntriesContent.tsx` | Unified entry page with navigation and pagination                   |
| `src/components/layout/Sidebar.tsx`                | Subscription delete via `useUnsubscribeMutation`                    |
| `src/lib/hooks/useUnsubscribeMutation.ts`          | Shared `subscriptions.delete` choreography (sidebar + broken feeds) |

## Adding New Cache Updates

1. **Can we update directly?** (full data available, simple key) — Yes → cache helpers in `src/lib/cache/`; No → invalidate.
2. **Entry lists**: patch in place via `entry-cache.ts` helpers; never trigger a refetch from an event — lists refresh on navigation (`useEntryListRefreshOnNavigate`).
3. **Unread counts**: set absolute server-provided counts via `setBulkCounts` / `setEntryRelatedCounts` (idempotent — never deltas).
4. **Handle races**: check existence before add/remove; SSE may deliver the same update as the mutation response.
5. **Update this document** and add unit tests in `tests/unit/frontend/cache/`.
