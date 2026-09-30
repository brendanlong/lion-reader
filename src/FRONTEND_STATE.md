# Frontend State Management

This document is the contract for how queries, mutations, and SSE events update client state (the local entry store and the React Query cache). Keep it updated when changing queries/mutations/SSE handling.

## Architecture Overview

React Query (via tRPC) is the network layer for everything. Entries additionally
live in a **local normalized store** (TanStack DB, `src/lib/local-db/`), which is
what entry lists, the reader, and the loading fallbacks render from:

| Data                    | Lives in                                   | Updated by                                                          |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| Entry list-item fields  | Local store: one row per entry             | Ingested fetches, mutation responses, SSE — newest `updatedAt` wins |
| Entry list membership   | Local store: `{ listKey, entryId, order }` | Ingested fetches; live inserts of new/newly-unread entries          |
| Entry content           | React Query `entries.get`                  | Fetch; `fetchFullContent` response                                  |
| Subscription/tag counts | React Query (absolute values)              | Direct update from responses and events                             |
| Subscription list       | React Query (sidebar `subscriptions.list`) | Direct update (add/remove)                                          |

**Ingestion.** `getLocalDb(queryClient)` (one store per QueryClient — never
module-global, since the server has one QueryClient per request) subscribes to
the QueryCache and ingests every `entries.list` and `entries.get` result as it
lands: SSR-hydrated, prefetched, fetched, and `setQueryData`'d data all take the
same path. `entries.list` pages are written to the entry store and to the list's
membership; a next-page fetch (`fetchMeta.fetchMore`, not a manual write)
appends, anything else replaces the list's membership — except entries inserted
live after that fetch started: its server snapshot predates them, so they are
kept rather than dropped when it lands. Removing the query from
the cache (gc) drops the list's membership rows. Never write entry state into
`entries.list` or `entries.get`, or render state from them: their copies are
only as fresh as their fetch.

**Membership never follows state.** A list's rows change only when it is fetched
or when an entry is inserted live — never when an entry's read/starred state
changes — so read entries stay visible in unread-only views until the list
refreshes. Lists sort by `order ASC` plus an id tiebreak: `order` is the negated
(newest-first) or plain (oldest-first) `COALESCE(publishedAt, fetchedAt)` in ms,
or the fetch position for search and Recently Read, whose order entries can't
reproduce.

Entry lists (`entries.list`, `staleTime: Infinity`) are never refetched on a
timer or window focus. Mutations and SSE events update the store (state and
live inserts) instead, and the single navigation-triggered refresh is `useEntryListRefreshOnNavigate`
(mounted in `AppRouter`): on any pathname change it runs `refreshEntryLists`,
which cancels in-flight fetches on inactive lists (a completing fetch would
clear the staleness flag) and then invalidates every `entries.list` query not
currently fetching — the active one refetches, inactive ones refetch on next
mount. Because the open entry lives in the `?entry=` search param, moving
between a list and an entry in it never changes the pathname and never
refreshes the list (read entries stay visible under the reader). The sidebar
calls the same `refreshEntryLists` when a link matching the current pathname
is clicked, so clicking the current list acts as an explicit refresh.

A next-page fetch can't clobber a mid-fetch read/starred change (#1081):
state lives in the entry store, and a page fetched before the change carries an
older `updatedAt`, so it is skipped for that entry.

## Local Store (`src/lib/local-db/`)

| File                   | Role                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `synced-collection.ts` | A TanStack DB collection whose synced layer we write from server data (`begin({ immediate: true })`, so writes land under pending optimistic changes) |
| `entries.ts`           | Entry rows and the `updatedAt`-guarded server writes: `upsertServerEntries`, `setServerEntryState`, `patchServerEntryMetadata`                        |
| `entry-lists.ts`       | List membership: `ingestEntryListPages`, `insertIntoMatchingLists` (filter targeting, pagination window), `entryListKey`                              |
| `local-db.ts`          | `getLocalDb` (per-QueryClient store + QueryCache ingestion), `insertEntryIntoLists` / `addServerEntryToLists`                                         |

Components read it through `src/lib/hooks/useLocalEntries.ts`:
`useEntryListEntries(input)` (a list, in order), `useLocalEntry(id)`, and
`useLocalEntriesMatching(filters)` — the entry-list loading fallback, which shows
stored entries matching the view's filters while its first page loads.

## Cache Helpers (`src/lib/cache/`)

| File                | Role                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operations.ts`     | High-level operations (primary API): `setBulkCounts`/`setEntryRelatedCounts` (absolute counts), `handleSubscriptionCreated`/`handleSubscriptionDeleted`, `removeSubscriptionFromCaches`                 |
| `count-cache.ts`    | Session-created subscription map + tag helpers: `addSubscriptionToCache`, `updateSubscriptionInCache`, `removeSubscriptionFromCache`, `findCachedSubscription`, `applySyncTagChanges`, `removeSyncTags` |
| `event-handlers.ts` | `handleSyncEvent` — dispatches SSE/sync events to the local store and the operations above                                                                                                              |

## Core Queries

| Query                           | Used In                                                    | Notes                                                                                                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `entries.list` (infinite)       | `EntryList`, `EntryListContainer`, `UnifiedEntriesContent` | Filters: `subscriptionId`, `tagId`, `uncategorized`, `unreadOnly`, `starredOnly`, `sortOrder`, `sortBy` (`"published"` \| `"readChanged"`), `type`, `excludeTypes`, `query` (full-text search), `limit`. `staleTime: Infinity` |
| `entries.get`                   | `EntryContent`                                             | Single entry with full content (includes `fetchFullContent`, so no separate subscription query needed)                                                                                                                         |
| `subscriptions.get`             | `UnifiedEntriesContent`                                    | Resolves the route/reader title for `/subscription/[id]`; falls back to the sidebar list cache until it resolves                                                                                                               |
| `entries.count`                 | `Sidebar`                                                  | `{}`, `{ type: "saved" }`, or `{ starredOnly: true }` badges                                                                                                                                                                   |
| `subscriptions.list` (infinite) | `TagSubscriptionList` (sidebar)                            | The sidebar per-tag / per-uncategorized subscription list (`{ tagId }` or `{ uncategorized }`). This is the only remaining consumer of `subscriptions.list`.                                                                   |
| `tags.list`                     | `Sidebar`, `EditSubscriptionDialog`, `TagManagement`       | All tags with unread + uncategorized counts                                                                                                                                                                                    |

`sortBy: "readChanged"` backs the `/recently-read` view (entries sorted by `read_changed_at` rather than publish time; defaults to `unreadOnly=false`). It and search (`query`) lists get **no** live inserts: `insertIntoMatchingLists` (`src/lib/local-db/entry-lists.ts`) skips any list whose input has a `query` or a `sortBy` other than `"published"`, because their ordering (relevance rank / read-time) can't be derived from an entry's fields. Those views instead refresh on navigation like any other list.

`query` backs the entry search UI (#565): the `?q=` URL param (set by the search bar in `EntryPageLayout`, opened via the header toggle or `/`) flows through `parseViewPreferencesFromParams` → `buildEntriesListInput` → `useEntriesListInput`, so search results reuse the same `entries.list` infinite-query machinery scoped to the current view's filters, and `EntryListPage` prefetches them server-side for `?q=` deep links. While a `q` is present, the `unreadOnly` **default** flips to `false` (a search is usually for something already read; the toggle still works) and `sortOrder`/`direction` are canonicalized to `"newest"`/`"forward"` in the input (the backend ranks search results by relevance and ignores sort order — a lingering `?sort=` param must not fragment the cache key).

## Mutations

### Entry Mutations (`useEntryMutations`)

| Mutation                   | Cache Updates                                                                                                                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entries.markRead`         | Optimistic transaction on the entry store; the response's state is written to the store (mark-unread also inserts the entry into unread-only lists missing it); absolute counts from the response via `setBulkCounts`                                                   |
| `entries.setStarred`       | Exposed as `star`/`unstar` in the hook. Optimistic transaction on the entry store; the response's state is written to the store; absolute counts from the response via `setBulkCounts`                                                                                  |
| `entries.markAllRead`      | Invalidate: `entries.list`, `subscriptions.list`, `tags.list`, `entries.count` (bulk operation, direct update not practical). The server also publishes one `mark_all_read` SSE event so other tabs/devices invalidate the same caches without waiting for a sync poll. |
| `entries.fetchFullContent` | Direct: patch `entries.get({ id })` with the returned `result.entry` via `utils.entries.get.setData` (in `EntryContent`; ingested into the store like any `entries.get` result). Only when the response has no `entry` does it fall back to `invalidate({ id })`.       |

### Subscription Mutations

| Mutation                | Used In                                  | Cache Updates                                                                                                 |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `subscriptions.create`  | Subscribe page                           | `handleSubscriptionCreated`: add to `subscriptions.list` + set absolute `counts` from response (`onSuccess`)  |
| `subscriptions.update`  | `EntryContent`, `EditSubscriptionDialog` | Invalidate `subscriptions.list`; `EntryContent` also patches `entries.get` for `fetchFullContent` changes     |
| `subscriptions.delete`  | `Sidebar`, Broken feeds                  | Optimistic remove (`onMutate`); set absolute `counts` from response + invalidate `entries.list` (`onSuccess`) |
| `subscriptions.setTags` | `EditSubscriptionDialog`                 | (handled by dialog close)                                                                                     |
| `subscriptions.import`  | `OpmlImportExport`                       | Toast + navigate; `import_progress`/`import_completed` SSE events invalidate `imports.*`                      |
| `imports.preview`       | `OpmlImportExport`                       | None (pure server-side OPML parse for the preview list; no cached data changes)                               |

Tag mutations (`tags.create/update/delete`) invalidate/patch via their components; the corresponding SSE events keep other tabs in sync.

**No-op re-saves publish nothing** (#1160, "Row Written vs. Value Flipped" in `src/server/CLAUDE.md`): other tabs only see `subscription_updated` for genuine changes; the acting tab still updates its own cache as listed above.

## Real-Time Updates

`useRealtimeUpdates` manages the SSE connection (polling fallback via `sync.events`) and feeds every event through `handleSyncEvent`.

**Key principle:** SSE events write the local store and caches directly and must NOT trigger `entries.*` refetches (enforced by e2e tests via `recordTrpcProcedures`). Counts are always set to absolute server-provided values (idempotent — duplicate SSE/sync delivery can't drift them). The **one deliberate exception** is `mark_all_read`: mark-all-read is unbounded, so patching every entry (or shipping every id) isn't worth it, and the event invalidates `entries.list` instead — refetching a list the user just cleared is an acceptable rare cost.

**Catch-up sync after (re)connect (#1081):** on SSE `open`, `useRealtimeUpdates` runs a catch-up sync against `sync.events` from the current cursors. Two invariants keep it from losing changes made while disconnected:

- **Retry on failure.** A failed catch-up sync is retried with exponential backoff (2s→30s) even in the `connected` phase (the `polling` phase already retries every 30s). A single failure used to be swallowed as "done", stranding the gap forever on an idle view.
- **Cursor freeze until caught up.** Live SSE events patch the cache immediately but do **not** advance the persisted sync cursor until the connection's catch-up sync has fully succeeded (`caughtUpRef`). Otherwise a live event would push the cursor past the not-yet-synced gap, making the pending/retrying catch-up query skip the gap's rows. The catch-up sync itself always advances the cursor (it drains the authoritative server sequence). Any stream error (including the browser's silent EventSource auto-reconnect) re-freezes the cursor so the next catch-up re-covers whatever was missed.
- **Hold the catch-up's start (#1663).** Every page of a catch-up sends where it started as `entriesSince`, so an entry pushed onto a later page by a newer change still gets its earlier `new_entry`/`entry_updated`. The start is cleared only when a page reports no more — deliberately kept through failures and reconnects, since an older start only re-reports changes (harmless) while a newer one loses them.

| SSE Event              | Cache Updates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new_entry`            | Direct: absolute counts via `setEntryRelatedCounts`; stores the event's `entry` payload and inserts it into matching loaded lists via `addServerEntryToLists` (tag/uncategorized membership from the cached subscription — conservatively skipped when uncached; skips search/unknown-filter lists and entries beyond the loaded pagination window). Spam entries carry no payload. The catch-up sync path sets `read`/`starred` for entries that changed state on another device; the live path omits them. Idempotent (absolute counts, insert deduped by ID). |
| `entry_updated`        | Direct: the stored entry's metadata (title, author, summary, url, publishedAt), which the reader renders too. No invalidation — avoids a race when the entry is open.                                                                                                                                                                                                                                                                                                                                                                                            |
| `entry_state_changed`  | Direct: the stored entry's read/starred (skipped when older than the stored `updatedAt`); absolute counts via `setEntryRelatedCounts`. Entries becoming unread are inserted into the lists missing them: events for unread flips carry a list-item payload (like `new_entry`; omitted for spam) — so the entry appears even when the store doesn't hold it (marked unread on another device/MCP, issue #1237); payload-less events (older servers, star/unstar of an unread entry) fall back to the stored row.                                                  |
| `mark_all_read`        | A `markAllRead` happened on another tab/device. Invalidate `entries.list`, `entries.count`, `tags.list`, `subscriptions.list` — the same thing the acting tab does on success. This is the **one** deliberate `entries.list` refetch (see Key principle above). Advances the entries cursor so a reconnect catch-up doesn't re-deliver every marked entry.                                                                                                                                                                                                       |
| `subscription_created` | Add to `subscriptions.list`; absolute counts from server `counts` (live path). The sync.events catch-up path omits `counts`, so the client invalidates `tags.list` + `entries.count` instead.                                                                                                                                                                                                                                                                                                                                                                    |
| `subscription_updated` | Patch subscription in lookup map/list caches; invalidate `tags.list` + `subscriptions.list` (tag membership may have changed).                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `subscription_deleted` | Remove from `subscriptions.list`; absolute counts (live path) or invalidate `tags.list` + `entries.count` (catch-up). The count update **and** `entries.list` invalidation always run — even when the subscription isn't cached (optimistically removed, or never loaded with tags collapsed); only the structural removal is gated on the subscription being cached (#1081).                                                                                                                                                                                    |
| `tag_created`          | `applySyncTagChanges` — add to `tags.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `tag_updated`          | `applySyncTagChanges` — patch in `tags.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tag_deleted`          | `removeSyncTags` — remove from `tags.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `import_progress`      | Invalidate: `imports.get({ id })`, `imports.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `import_completed`     | Invalidate: `imports.get({ id })`, `imports.list`. Entry/subscription changes arrive as individual events during import.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `announcement_changed` | **Global broadcast** (site-status channel, not per-user): the admin changed the announcement banner. No React Query cache is touched — it calls `setLiveAnnouncement` (`@/lib/site-status/announcement-store`), a module store the SPA-layout (`src/app/(spa)/(app)/layout.tsx`) `AnnouncementBanner` subscribes to via `useSyncExternalStore`. `announcement` is null when disabled/cleared (hides the banner). Not part of the `sync.events` catch-up (SSE-only), so a change during a disconnect is picked up on the next full page load.                     |

## Optimistic Updates

Optimistic updates never cancel in-flight queries (cancelling `entries.get`
aborts content fetches and strands placeholder data), so React Query's stock
`onMutate` + `cancelQueries` + rollback recipe is not used anywhere. Three
patterns exist; pick by what the mutation changes, and don't add a fourth:

| Mutation changes                                                | Pattern                                                  | Used by                                                        |
| --------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| Per-entry state that several mutations can touch at once        | TanStack DB transaction + `updatedAt`-guarded writes     | `useEntryMutations` (`entries.markRead`, `entries.setStarred`) |
| Removal of a row the client already holds                       | Optimistic remove + invalidate-to-truth on error         | `useUnsubscribeMutation` (`subscriptions.delete`)              |
| Data only the server can produce (ids, resolved titles, counts) | No optimistic phase; apply the response via the SSE path | `subscriptions.create` → `handleSubscriptionCreated`           |

### TanStack DB transaction + `updatedAt`-guarded writes

Read/starred mutations for one entry can overlap (auto-mark-read on open, a
keyboard toggle a moment later, star while the mark-read is in flight) and
their responses can complete out of order. `useEntryMutations` runs each as a
TanStack DB transaction on the shared entry store:

1. The intended state is applied as an **optimistic overlay** on the entries
   the store holds (entries it doesn't hold have nothing on screen, so the
   mutation is just sent).
2. The mutation function sends the request and writes the response to the
   store's **synced layer** through `setServerEntryState`, which skips a
   response older than the stored `updatedAt`
   (`GREATEST(entry.updated_at, user_entry.updated_at)`). Out-of-order
   responses therefore resolve to the newest server state, as do fetches and
   SSE events that land mid-flight.
3. When the transaction settles the overlay drops, leaving the synced state;
   on failure that is the last state the server reported (including any SSE
   change that arrived mid-flight), and the hook toasts.

An overlay is a snapshot of the whole row as of when the mutation was made
(TanStack DB semantics), so while a mutation is pending, server changes to the
entry's _other_ fields stay hidden until it settles, and one of two stacked
mutations failing rolls nothing back until the other settles too.

Counts are applied separately from the response (absolute values, see
"Mutation Response Shapes") and are not subject to the timestamp guard.

### Optimistic remove + invalidate-to-truth

A removal has nothing to reconcile — there is no second concurrent delete and
no server timestamp to compare — so on error the caches are invalidated rather
than the row hand-restored. `useUnsubscribeMutation` is the one implementation;
reserve the pattern for removals.

### No optimistic phase

When the client can't build the row itself, apply the mutation response
through the same function the corresponding SSE event uses
(`handleSubscriptionCreated`), so the response and the event — which may arrive
in either order — stay duplicate-safe.

### Auto-mark-read (EntryContent)

Opening an entry fires `markRead` once, as soon as `entries.get` data is available (straight from cache when a prefetch warmed it, otherwise when the fetch lands) — even for an already-read entry, so its `readChangedAt` moves it to the top of Recently Read. The optimistic update shows read state instantly, and the `updatedAt` guard resolves it against any `entries.get` fetch still in flight.

## Mutation Response Shapes

Mutations return everything cache updates need (the client never derives counts locally); see the procedures' output schemas for the shapes.

`counts` is **absent when no value actually flipped** (a same-value re-assert —
e.g. marking an already-read entry read again — writes the row to advance the
last-write-wins watermark but changes nothing the user can see, so the server
skips the count aggregation; issue #1118). The `onSuccess` handlers apply counts
only when present; absent counts mean the cached counts are already correct. The
same rule gates the server's `entry_state_changed` SSE publish, so re-asserts
emit no event at all.

Re-asserts likewise don't churn delta sync — see "Row Written vs. Value Flipped" in `src/server/CLAUDE.md`.

## Key Files

| File                                               | Purpose                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `src/lib/local-db/*` (see table above)             | Local entry store, list membership, QueryCache ingestion            |
| `src/lib/cache/*` (see table above)                | Count/subscription/tag cache operations, SSE event dispatch         |
| `src/lib/hooks/useEntryMutations.ts`               | Entry mutations: TanStack DB transactions on the entry store        |
| `src/lib/hooks/useEntryListRefreshOnNavigate.ts`   | Navigation-triggered entry list invalidation (pathname change)      |
| `src/lib/hooks/useRealtimeUpdates.ts`              | SSE/polling glue feeding the connection machine                     |
| `src/lib/events/connection-state.ts`               | Pure connection state machine (reconnect/backoff/polling fallback)  |
| `src/lib/events/cursors.ts`                        | Pure sync-cursor bookkeeping                                        |
| `src/components/entries/EntryListContainer.tsx`    | Stateful entry list container (query, pagination, keyboard nav)     |
| `src/components/entries/UnifiedEntriesContent.tsx` | Unified entry page with navigation and pagination                   |
| `src/components/layout/Sidebar.tsx`                | Subscription delete via `useUnsubscribeMutation`                    |
| `src/lib/hooks/useUnsubscribeMutation.ts`          | Shared `subscriptions.delete` choreography (sidebar + broken feeds) |
| `src/lib/trpc/handler-link.ts`                     | In-process tRPC link (component tests, the public demo's store)     |

## Adding New Cache Updates

1. **Entries**: write the local store through the `updatedAt`-guarded functions in `src/lib/local-db/entries.ts`, and add entries to lists with `insertEntryIntoLists`/`addServerEntryToLists`; never write entry state to `entries.list`/`entries.get`, and never trigger a list refetch from an event — lists refresh on navigation (`useEntryListRefreshOnNavigate`).
2. **Everything else: can we update directly?** (full data available, simple key) — Yes → cache helpers in `src/lib/cache/`; No → invalidate.
3. **Unread counts**: set absolute server-provided counts via `setBulkCounts` / `setEntryRelatedCounts` (idempotent — never deltas).
4. **Handle races**: check existence before add/remove; SSE may deliver the same update as the mutation response.
5. **Update this document** and add unit tests in `tests/unit/frontend/local-db/` or `tests/unit/frontend/cache/`.
