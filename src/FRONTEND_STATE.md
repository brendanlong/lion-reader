# Frontend State Management

This document is the contract for how queries, mutations, and SSE events update client state (the local entry store and the React Query cache). Keep it updated when changing queries/mutations/SSE handling. Flow diagrams: `docs/diagrams/frontend-data-flow.d2`, `docs/diagrams/sse-cache-updates.d2`.

## Architecture Overview

React Query (via tRPC) is the network layer for everything. Entries and
subscriptions additionally live in a **local normalized store** (TanStack DB,
`src/lib/local-db/`), which is what entry lists, the reader, the loading
fallbacks, and the sidebar's subscription rows render from:

| Data                   | Lives in                                     | Updated by                                                                           |
| ---------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Entry list-item fields | Local store: one row per entry               | Ingested fetches, mutation responses, SSE — newest `updatedAt` wins, per field group |
| Entry list membership  | Local store: `{ listKey, entryId, order }`   | Ingested fetches; live inserts of new/newly-unread entries                           |
| Entry content          | React Query `entries.get`                    | Fetch; `fetchFullContent` response                                                   |
| Subscriptions          | Local store: one row per loaded subscription | Ingested fetches, responses and events; counts set its `unreadCount`                 |
| Tag/global counts      | React Query (absolute values)                | Direct update from responses and events                                              |

**Ingestion.** `getLocalDb(queryClient)` (one store per QueryClient — never
module-global, since the server has one QueryClient per request) subscribes to
the QueryCache and ingests every `entries.list`, `entries.get`,
`subscriptions.list` and `subscriptions.get` result as it lands: SSR-hydrated, prefetched, fetched, and `setQueryData`'d data all take the
same path. `entries.list` pages are written to the entry store and to the list's
membership; a next-page fetch (`fetchMeta.fetchMore`, not a manual write)
appends, anything else replaces the list's membership — except entries inserted
live after that fetch started: its server snapshot predates them, so they are
kept rather than dropped when it lands. Removing the query from
the cache (gc) drops the list's membership rows. Never write entry state into
`entries.list` or `entries.get`, or render state from them: their copies are
only as fresh as their fetch.

**Membership never follows state.** A list's rows change only when it is fetched,
when an entry is inserted live, or when an entry joins or leaves the collection a
list shows (`applyCollectionEntriesChange`) — never when an entry's read/starred
state changes — so read entries stay visible (and j/k keeps working from the
open one) until the list refreshes. Leaving a collection is the user saying they
don't want the entry there, so it hides at once, except as the open entry
(`useEntryListEntries` takes `openEntryId`) so j/k keeps its place. Lists sort
by `order ASC` plus an id tiebreak: `order` is the negated
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

A next-page fetch can't clobber a mid-fetch change (#1081): entries live in the
store, which tracks freshness separately for read/starred **state** and for the
entry's **metadata** (title, summary, …), since writes like `entry_updated` or a
mark-read response carry only one of them. A page fetched before a change
carries an older `updatedAt` than the change, so that group is skipped for the
entry while the other still applies (`mergeServerEntry`).

## Local Store (`src/lib/local-db/`)

| File                   | Role                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `synced-collection.ts` | A TanStack DB collection whose synced layer we write from server data (`begin({ immediate: true })`, so writes land under pending optimistic changes)                      |
| `entries.ts`           | Entry rows and their server writes, all through `mergeServerEntry` (per-group `updatedAt` guard): `upsertServerEntries`, `setServerEntryState`, `patchServerEntryMetadata` |
| `entry-lists.ts`       | List membership: `ingestEntryListPages`, `insertIntoMatchingLists` (filter targeting, pagination window), `entryListKey`                                                   |
| `subscriptions.ts`     | Subscription rows: live writes (`writeLiveSubscriptions`, `patchLiveSubscription`, `removeLiveSubscriptions`), fetch ingestion, and `sidebarSectionRows`                   |
| `local-db.ts`          | `getLocalDb` (per-QueryClient store + QueryCache ingestion), `insertEntryIntoLists` / `addServerEntryToLists`                                                              |

Components read it through `src/lib/hooks/useLocalEntries.ts`:
`useEntryListEntries(input)` (a list, in order), `useLocalEntry(id)`, and
`useLocalEntriesMatching(filters)` — the entry-list loading fallback, which shows
stored entries matching the view's filters while its first page loads — and
`src/lib/hooks/useLocalSubscriptions.ts`.

**Subscriptions.** The store holds only the subscriptions something loaded,
not every one the user has (users can have many collections). Each sidebar section is derived
from it (`sidebarSectionRows`): rows in the section, with unread entries when
unread-only (plus the open subscription), within what the section's own
`subscriptions.list` pages cover. So counts, renames and tag changes move rows
in and out of sections with no list refetch. These rules keep it complete and current:

- A subscription the store lacks is fetched (`subscriptions.get`) when counts
  give it unread entries or an event moves it into a section, if a loaded
  section may list it (`loadSubscriptionForSidebar`; counts carry each
  subscription's `tagIds` so collapsed sections cost nothing).
- Every write is versioned: a live write (event, response, counts) by when it
  happened, a fetched row by when its fetch started. A fetched row is stored
  only over an older version, so a fetch can't undo a newer write or a
  removal, and a next page stores only its own rows.
- Once an unread-only section's pages cover all of it, a stored row in the
  section that they don't return, and that's no newer than they are, gets an
  unread count of 0 (a change this client wasn't told about, like
  mark-all-read). Sections with unloaded pages are left alone: only the
  server's collation says which rows those pages cover.

Rows a section loaded keep the server's order (its collation); others are
placed by title among them.

## Cache Helpers (`src/lib/cache/`)

| File                | Role                                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operations.ts`     | High-level operations (primary API): `setBulkCounts`/`setEntryRelatedCounts` (absolute counts), `handleSubscriptionCreated`/`handleSubscriptionDeleted`, `removeSubscriptionFromCaches` |
| `tag-cache.ts`      | Tag event helpers: `applySyncTagChanges`, `removeSyncTags`                                                                                                                              |
| `event-handlers.ts` | `handleSyncEvent` — dispatches SSE/sync events to the local store and the operations above                                                                                              |

## Core Queries

| Query                           | Used In                                                    | Notes                                                                                                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entries.list` (infinite)       | `EntryList`, `EntryListContainer`, `UnifiedEntriesContent` | `staleTime: Infinity`                                                                                                                                                                                                                                            |
| `entries.get`                   | `EntryContent`                                             | Single entry with full content (includes `fetchFullContent`, so no separate subscription query needed)                                                                                                                                                           |
| `subscriptions.get`             | `UnifiedEntriesContent`, `useSidebarSelection`             | Loads one subscription into the store (the route title and the open subscription render from the store); deleting the subscription resets it.                                                                                                                    |
| `entries.count`                 | `Sidebar`                                                  | `{}`, `{ type: "saved" }`, or `{ starredOnly: true }` badges                                                                                                                                                                                                     |
| `subscriptions.list` (infinite) | `TagSubscriptionList` (sidebar)                            | Loads a sidebar section's pages (`{ tagId }` or `{ uncategorized }`) into the store; the section renders from the store, limited to what these pages cover. Never written directly. `CollectionsButton` also searches collections with `{ type: "collection" }`. |
| `collections.listForEntry`      | `CollectionsButton`                                        | The collections holding an entry. Kept out of the entry store and `entries.get`; written by `applyCollectionEntriesChange`, and invalidated after a catch-up sync (membership events aren't replayed).                                                           |
| `tags.list`                     | `Sidebar`, `EditSubscriptionDialog`, `TagManagement`       | All tags with unread + uncategorized counts                                                                                                                                                                                                                      |

`sortBy: "readChanged"` backs the `/recently-read` view (entries sorted by `read_changed_at` rather than publish time; defaults to `unreadOnly=false`). It and search (`query`) lists get **no** live inserts: `insertIntoMatchingLists` (`src/lib/local-db/entry-lists.ts`) skips any list whose input has a `query` or a `sortBy` other than `"published"`, because their ordering (relevance rank / read-time) can't be derived from an entry's fields. Those views instead refresh on navigation like any other list.

Search (`?q=`) is an ordinary `entries.list` scoped to the current view's filters. With a query present, `unreadOnly` defaults to `false` and sort order is canonicalized in the input, since results are ranked by relevance and a stray `?sort=` must not fragment the cache key.

## Mutations

### Entry Mutations (`useEntryMutations`)

| Mutation                   | Cache Updates                                                                                                                                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entries.markRead`         | Optimistic transaction on the entry store; the response's state is written to the store (mark-unread also inserts the entry into unread-only lists missing it); absolute counts from the response via `setBulkCounts`                                                                        |
| `entries.setStarred`       | Exposed as `star`/`unstar` in the hook. Optimistic transaction on the entry store; the response's state is written to the store; absolute counts from the response via `setBulkCounts`                                                                                                       |
| `entries.markAllRead`      | Invalidate: `entries.list`, `subscriptions.list`, `subscriptions.get`, `tags.list`, `entries.count` (bulk operation, direct update not practical). The server also publishes one `mark_all_read` SSE event so other tabs/devices invalidate the same caches without waiting for a sync poll. |
| `entries.fetchFullContent` | Direct: patch `entries.get({ id })` with the returned `result.entry` via `utils.entries.get.setData` (in `EntryContent`; ingested into the store like any `entries.get` result). Only when the response has no `entry` does it fall back to `invalidate({ id })`.                            |

### Subscription Mutations

| Mutation                | Used In                                  | Cache Updates                                                                                                                                 |
| ----------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscriptions.create`  | Subscribe page                           | `handleSubscriptionCreated`: add to the store + set absolute `counts` from response (`onSuccess`)                                             |
| `subscriptions.update`  | `EntryContent`, `EditSubscriptionDialog` | Invalidate `subscriptions.list`; `EntryContent` also patches `entries.get` for `fetchFullContent` changes                                     |
| `subscriptions.delete`  | `Sidebar`, Broken feeds                  | Optimistic remove (`onMutate`); set absolute `counts` from response + invalidate `entries.list` + reset its `subscriptions.get` (`onSuccess`) |
| `subscriptions.setTags` | `EditSubscriptionDialog`                 | (handled by dialog close)                                                                                                                     |
| `subscriptions.import`  | `OpmlImportExport`                       | Toast + navigate; `import_progress`/`import_completed` SSE events invalidate `imports.*`                                                      |
| `imports.preview`       | `OpmlImportExport`                       | None (pure server-side OPML parse for the preview list; no cached data changes)                                                               |

Collection mutations (`useCollectionMembership`): `collections.addEntries` / `removeEntries` apply the response through `applyCollectionEntriesChange`; `collections.create` goes through `handleSubscriptionCreated`. Deleting a collection is `subscriptions.delete`.

Tag mutations (`tags.create/update/delete`) invalidate/patch via their components; the corresponding SSE events keep other tabs in sync.

No-op re-saves publish no `subscription_updated` ("Row Written vs. Value Flipped" in `src/server/CLAUDE.md`); the acting tab still updates its own cache.

## Real-Time Updates

`useRealtimeUpdates` manages the SSE connection (polling fallback via `sync.events`) and feeds every event through `handleSyncEvent`.

**Key principle:** SSE events write the local store and caches directly and must NOT trigger `entries.*` refetches (enforced by e2e tests via `recordTrpcProcedures`). Counts are always set to absolute server-provided values (idempotent — duplicate SSE/sync delivery can't drift them). The **one deliberate exception** is `mark_all_read`: mark-all-read is unbounded, so patching every entry (or shipping every id) isn't worth it, and the event invalidates `entries.list` instead — refetching a list the user just cleared is an acceptable rare cost.

**Catch-up sync after (re)connect (#1081):** on SSE `open`, `useRealtimeUpdates` runs a catch-up sync against `sync.events` from the current cursors. Its decisions live in the pure reducer `reduceSyncSession` (`src/lib/events/sync-session.ts`), which upholds these invariants so it can't lose changes made while disconnected:

- **Retry on failure.** A failed catch-up sync is retried with exponential backoff (2s→30s) even in the `connected` phase (the `polling` phase already retries every 30s). Without the retry, one failure would strand the gap on an idle view.
- **Cursor freeze until caught up.** Live SSE events patch the cache immediately but do **not** advance the persisted sync cursor until the connection's catch-up sync has fully succeeded (`caughtUp`). Otherwise a live event would push the cursor past the not-yet-synced gap, making the pending/retrying catch-up query skip the gap's rows. The catch-up sync itself always advances the cursor (it drains the authoritative server sequence). Any stream error (including the browser's silent EventSource auto-reconnect) re-freezes the cursor so the next catch-up re-covers whatever was missed.
- **Hold the catch-up's start (#1663).** Every page of a catch-up sends where it started as `entriesSince`, so an entry pushed onto a later page by a newer change still gets its earlier `new_entry`/`entry_updated`. The start is cleared only when a page reports no more — deliberately kept through failures and reconnects, since an older start only re-reports changes (harmless) while a newer one loses them.

| SSE Event                    | Cache Updates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new_entry`                  | Direct: absolute counts via `setEntryRelatedCounts`; stores the event's `entry` payload and inserts it into matching loaded lists via `addServerEntryToLists` (tag/uncategorized membership from the cached subscription — conservatively skipped when uncached; skips search/unknown-filter lists and entries beyond the loaded pagination window). Spam entries carry no payload. The catch-up sync path sets `read`/`starred` for entries that changed state on another device; the live path omits them. Idempotent (absolute counts, insert deduped by ID). |
| `entry_updated`              | Direct: the stored entry's metadata (title, author, summary, url, publishedAt; skipped when older than the stored metadata), which the reader renders too. No invalidation — avoids a race when the entry is open.                                                                                                                                                                                                                                                                                                                                               |
| `entry_state_changed`        | Direct: the stored entry's read/starred (skipped when older than the stored state); absolute counts via `setEntryRelatedCounts`. Entries becoming unread are inserted into the lists missing them: events for unread flips carry a list-item payload (like `new_entry`; omitted for spam) — so the entry appears even when the store doesn't hold it (marked unread on another device/MCP, issue #1237); payload-less events (older servers, star/unstar of an unread entry) fall back to the stored row.                                                        |
| `mark_all_read`              | A `markAllRead` happened on another tab/device. Invalidate `entries.list`, `entries.count`, `tags.list`, `subscriptions.list`, `subscriptions.get` — the same thing the acting tab does on success. This is the **one** deliberate `entries.list` refetch (see Key principle above). Advances the entries cursor so a reconnect catch-up doesn't re-deliver every marked entry.                                                                                                                                                                                  |
| `subscription_created`       | Add to the store; absolute counts from server `counts` (live path). The sync.events catch-up path omits `counts`, so the client invalidates `tags.list` + `entries.count` instead.                                                                                                                                                                                                                                                                                                                                                                               |
| `subscription_updated`       | Patch the stored row's tags and title (it moves between sections), or load it if a loaded section may now list it; invalidate `tags.list` (feed counts).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `subscription_deleted`       | Remove from the store and reset its `subscriptions.get`; absolute counts (live path) or invalidate `tags.list` + `entries.count` (catch-up). Runs in full even when the store doesn't hold it (optimistically removed, or never loaded with tags collapsed; #1081).                                                                                                                                                                                                                                                                                              |
| `collection_entries_changed` | `applyCollectionEntriesChange`: absolute counts, each entry's `collections.listForEntry` (invalidated when not loaded), and the collection's loaded lists (adds inserted from the stored row; removals hidden, see "Membership never follows state"). SSE-only: a catch-up sync re-delivers the entries as `entry_state_changed` and invalidates `collections.listForEntry`, `subscriptions.list` and `tags.list` (a collection an article left gets no replayed count); the collection's lists catch up on navigation.                                          |
| `tag_created`                | `applySyncTagChanges` — add to `tags.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `tag_updated`                | `applySyncTagChanges` — patch in `tags.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tag_deleted`                | `removeSyncTags` — remove from `tags.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `import_progress`            | Invalidate: `imports.get({ id })`, `imports.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `import_completed`           | Invalidate: `imports.get({ id })`, `imports.list`. Entry/subscription changes arrive as individual events during import.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `announcement_changed`       | **Global broadcast** (site-status channel, not per-user): the admin changed the announcement banner. No React Query cache is touched — it calls `setLiveAnnouncement` (`@/lib/site-status/announcement-store`), a module store the SPA-layout (`src/app/(spa)/(app)/layout.tsx`) `AnnouncementBanner` subscribes to via `useSyncExternalStore`. `announcement` is null when disabled/cleared (hides the banner). Not part of the `sync.events` catch-up (SSE-only), so a change during a disconnect is picked up on the next full page load.                     |

## Optimistic Updates

Optimistic updates never cancel in-flight queries (cancelling `entries.get`
aborts content fetches and strands placeholder data), so React Query's stock
`onMutate` + `cancelQueries` + rollback recipe is not used anywhere. Three
patterns exist; pick by what the mutation changes, and don't add a fourth:

| Mutation changes                                                | Pattern                                                  | Used by                                                                                                                                                          |
| --------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-entry state that several mutations can touch at once        | TanStack DB transaction + `updatedAt`-guarded writes     | `useEntryMutations` (`entries.markRead`, `entries.setStarred`)                                                                                                   |
| Removal of a row the client already holds                       | Optimistic remove + invalidate-to-truth on error         | `useUnsubscribeMutation` (`subscriptions.delete`)                                                                                                                |
| Data only the server can produce (ids, resolved titles, counts) | No optimistic phase; apply the response via the SSE path | `subscriptions.create` → `handleSubscriptionCreated`, collection membership (only articles the server sees as visible can join) → `applyCollectionEntriesChange` |

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
   response older than the stored state's `updatedAt`
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

On error the removed row is written back as it was, unless something wrote
it since (its `subscription_deleted` event can beat a timed-out response), and
the caches are invalidated; an unread-only refetch wouldn't return a read row
by itself. `useUnsubscribeMutation` is the one
implementation; reserve the pattern for removals.

### No optimistic phase

When the client can't build the row itself, apply the mutation response
through the same function the corresponding SSE event uses
(`handleSubscriptionCreated`), so the response and the event — which may arrive
in either order — stay duplicate-safe.

### Auto-mark-read (EntryContent)

Opening an entry fires `markRead` once, as soon as `entries.get` data is available (straight from cache when a prefetch warmed it, otherwise when the fetch lands) — even for an already-read entry, so its `readChangedAt` moves it to the top of Recently Read. The optimistic update shows read state instantly, and the `updatedAt` guard resolves it against any `entries.get` fetch still in flight.

## Mutation Response Shapes

Mutations return everything cache updates need (the client never derives counts locally); see the procedures' output schemas for the shapes.

`counts` is **absent when no value actually flipped** (a same-value re-assert;
"Row Written vs. Value Flipped" in `src/server/CLAUDE.md`), and such a write
publishes no `entry_state_changed`. Apply counts only when present; absent means
the cached counts are already correct.

## Adding New Cache Updates

1. **Entries**: write the local store through the `updatedAt`-guarded functions in `src/lib/local-db/entries.ts`, and add entries to lists with `insertEntryIntoLists`/`addServerEntryToLists`; never write entry state to `entries.list`/`entries.get`, and never trigger a list refetch from an event — lists refresh on navigation (`useEntryListRefreshOnNavigate`).
2. **Subscriptions**: write the store through `src/lib/local-db/subscriptions.ts`'s live writes; never write `subscriptions.list`/`subscriptions.get` data.
3. **Everything else: can we update directly?** (full data available, simple key) — Yes → cache helpers in `src/lib/cache/`; No → invalidate.
4. **Unread counts**: set absolute server-provided counts via `setBulkCounts` / `setEntryRelatedCounts` (idempotent — never deltas).
5. **Handle races**: check existence before add/remove; SSE may deliver the same update as the mutation response.
6. **Update this document** and add unit tests in `tests/unit/frontend/local-db/` or `tests/unit/frontend/cache/`.
