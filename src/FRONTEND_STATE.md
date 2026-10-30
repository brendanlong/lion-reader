# Frontend State Management

This document is the contract for how queries, mutations, and SSE events update client state (the local entry store and the React Query cache). Keep it updated when changing queries/mutations/SSE handling. Flow diagrams: `docs/diagrams/frontend-data-flow.d2`, `docs/diagrams/sse-cache-updates.d2`.

## Architecture Overview

React Query (via tRPC) is the network layer for everything. Entries,
subscriptions, tags and unread counts live in a **local normalized store**
(TanStack DB, `src/lib/local-db/`), which is what entry lists, the reader, the
loading fallbacks and the sidebar render from. React Query keeps only what's
fetched as a whole and never changed in place: entry content, and pagination
and loading state.

| Data                   | Lives in                                                                                                  | Updated by                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Entry list-item fields | Local store: one row per entry                                                                            | Ingested fetches, mutation responses, SSE — the newest write wins, per field group                               |
| Entry list membership  | Local store: `{ listKey, entryId, order }`                                                                | Ingested fetches; live inserts of new/newly-unread entries                                                       |
| Entry content          | React Query `entries.get`                                                                                 | Fetch; `fetchFullContent` response                                                                               |
| Subscriptions          | Local store: one row per loaded subscription                                                              | Ingested fetches, responses and events; counts set its `unreadCount`                                             |
| Tags                   | Local store: one row per tag                                                                              | Ingested `tags.list`, responses and events                                                                       |
| Unread counts          | Local store: one row per list (All, Starred, Saved, each tag, Uncategorized); a subscription's on its row | Ingested `entries.countLists`/`tags.list`/subscription rows, responses and events — the newest server stamp wins |

**Ingestion.** `getLocalDb(queryClient)` (one store per QueryClient — never
module-global, since the server has one QueryClient per request) subscribes to
the QueryCache and ingests every `entries.list`, `entries.get`,
`subscriptions.list`, `subscriptions.get`, `tags.list` and `entries.countLists`
result as it lands: SSR-hydrated, prefetched, fetched, and `setQueryData`'d data all take the
same path. `entries.list` pages are written to the entry store and to the list's
membership; a next-page fetch (`fetchMeta.fetchMore`, not a manual write)
appends, anything else replaces the list's membership — except entries inserted
live after that fetch started: its server snapshot predates them, so they are
kept rather than dropped when it lands. Removing the query from
the cache (gc) drops the list's membership rows. Never write into an ingested
query's data, or render from it: its copy is only as fresh as its fetch.
Components keep the query (for fetching, Suspense and errors) and render from
the store.

**Memberships, not types (#1846).** Every stored entry carries `subscriptionIds`,
every active subscription holding it: its origin (`subscriptionId`), its
collections and, for a saved article, the user's saved subscription. They
travel with the read/starred state (a membership change moves the server's
`user_entries.updated_at`), and they decide which lists a live insert reaches
(`insertEntryIntoLists`): a subscription or collection list by membership, tag
and Uncategorized lists by the entry's `tagLists`, and Saved by membership in
the saved subscription. The server sends `tagLists` with every entry and they
travel with `subscriptionIds`: **never derive tag membership from the stored
subscriptions**, which hold only the expanded sidebar sections (#2126). A
retag, an unsubscribe or a deleted tag re-delivers none of its entries, so it
sets their stored `tagLists` to null (unknown): tag and Uncategorized lists
skip them until the server sends them again. The server lists
the saved subscription, but the subscription store never holds it (so no
sidebar section shows it; Saved has its own nav item): its id is
`LocalDb.saved`, taken from its row in any `subscriptions.list`/`get` result
(null from an empty `{ type: "saved" }` list; a known id is never replaced by
null). The layout prefetches `SAVED_SUBSCRIPTION_LIST_INPUT` so it's always
known, and a saved article's `new_entry` while it's still null (the user's
first save) refetches it once per page load. Until it's known, nothing is in
Saved. An entry's `type` is otherwise for display only (a saved
article shows its site name) and the plain `web`/`email` filters; never infer
list membership from it, and never use a feed id (clients don't get one).

**Membership never follows state.** A list's rows change only when it is fetched,
when an entry is inserted live, or when an entry joins or leaves a collection
(`applyCollectionEntriesChange`) — never when an entry's read/starred
state changes — so read entries stay visible (and j/k keeps working from the
open one) until the list refreshes. Leaving a collection is the user saying they
don't want the entry there, so it hides at once from the collection's lists and
the tag and Uncategorized lists it no longer reaches, except as the open entry
(`useEntryListEntries` takes `openEntryId`) so j/k keeps its place. Each row
stores its place (`listOrder` in `entry-lists.ts`, compared only by
`comparePlaces`): by date, score or a collection's position as the server
orders them, entries without a value last (#2064), or the fetch position for
search and Recently Read, whose order entries can't reproduce. A list with no
sort in its URL is in the server's default (by position where there are
positions, else newest), which its first page reports (`sort`): rows, live
inserts and the sort control follow that. A row's place
is set when it lands, so a score or position change moves it only on the
list's next fetch. Which sorts a list can use (`sortable`, from its first
page) is stored per list (`useListSortable`); an `entry_state_changed` that
gives an entry in it a score or position turns that sort on, and the next
fetch turns off a sort whose values are gone.

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
carries an older timestamp for that group than the change, so that group is
skipped for the entry while the other still applies (`mergeServerEntry` says
which timestamp each write carries per group).

## Local Store (`src/lib/local-db/`)

| File                   | Role                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `synced-collection.ts` | A TanStack DB collection whose synced layer we write from server data (`begin({ immediate: true })`, so writes land under pending optimistic changes)                                                                            |
| `entries.ts`           | Entry rows and their server writes, all through `mergeServerEntry` (per-group `updatedAt` guard): `upsertServerEntries`, `setServerEntryState`, `patchServerEntryMetadata`                                                       |
| `entry-lists.ts`       | List membership: `ingestEntryListPages`, `insertIntoMatchingLists` (pagination window), `entryListKey`, and `entryMatchesList` / `compareListEntries`, the one copy of a list's filters and order (the demo store uses them too) |
| `subscriptions.ts`     | Subscription rows: live writes (`writeLiveSubscriptions`, `patchLiveSubscription`, `writeSubscriptionCount`), fetch ingestion, and `sidebarSectionRows`                                                                          |
| `tags.ts`              | Tag rows: fetch ingestion (a `tags.list` is every tag, so it drops stored tags it lacks) and live writes                                                                                                                         |
| `counts.ts`            | Unread counts by list (`countKey`), written only over an older stamp (`writeCounts`)                                                                                                                                             |
| `versioned-store.ts`   | Local-clock versioning for subscriptions and tags (see below)                                                                                                                                                                    |
| `local-db.ts`          | `getLocalDb` (per-QueryClient store + QueryCache ingestion, `saved`), `insertEntryIntoLists` / `addServerEntryToLists` (placement by memberships)                                                                                |

Components read it through `src/lib/hooks/useLocalEntries.ts`:
`useEntryListEntries(input)` (a list, in order), `useLocalEntry(id)`, and
`useLocalEntriesMatching(filters)` — the entry-list loading fallback, which shows
stored entries matching the view's filters (memberships included) while its
first page loads — and
`src/lib/hooks/useLocalSubscriptions.ts`, `useLocalTags.ts` (tags and
`useUnreadCount`) and `useSavedSubscriptionId.ts`. An entry's collections (the
picker) are its `subscriptionIds` but its origin and the saved subscription.

**Unread counts.** Every count the server sends is stamped with when it was
read (`countsAsOfSchema`), and the store keeps the newest per list, so a
response or event that arrives after a newer one, or a fetch that started
before it, can't regress a badge. A subscription's count is ordered the same
way but kept on its row, apart from the row's version, so a count-only write
doesn't make a fetch in flight drop the row's other fields.

**Subscriptions.** The store holds only the subscriptions something loaded,
not every one the user has (users can have many collections). Each sidebar section is derived
from it (`sidebarSectionRows`): rows in the section, with unread entries when
unread-only (plus the open subscription), within what the section's own
`subscriptions.list` pages cover. So counts, renames and tag changes move rows
in and out of sections with no list refetch. These rules keep it complete and current:

- A subscription the store lacks is fetched (`subscriptions.get`) when counts
  give it unread entries, if a loaded section may list it
  (`loadSubscriptionForSidebar`; counts carry each
  subscription's `tagIds` so collapsed sections cost nothing).
- Every write but a count is versioned (`versioned-store.ts`, tags too): a
  live write (event, response) by when it happened, a fetched row by when its
  fetch started. A fetched row is stored
  only over an older version, so a fetch can't undo a newer write or a
  removal, and a next page stores only its own rows.
- Every operation that changes counts sends them as absolute values, in its
  response and its event (mark-all-read included). A refetch can't say a row
  it left out went to zero (it may sort onto an unloaded page), so a new
  count-changing operation must send counts too.

Rows a section loaded keep the server's order (its collation); others are
placed by title among them.

## Cache Helpers (`src/lib/cache/`)

| File                | Role                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operations.ts`     | High-level operations (primary API), one per state change, shared by the mutation response and its event: `applyNewEntry`, `applyEntryStateChanges`, `applySubscriptionUpdate`, `handleSubscriptionCreated`/`handleSubscriptionDeleted`, `applyCollectionEntriesChange`, `handleMarkAllRead`, `applyTagChange`/`applyTagDeleted`; `applyUnreadCounts` (absolute counts) |
| `event-handlers.ts` | `handleSyncEvent` — dispatches SSE/sync events to the local store and the operations above                                                                                                                                                                                                                                                                              |

## Core Queries

Speculative fetches (prefetches) pass `UNBATCHED` (`src/lib/trpc/client.ts`).

| Query                           | Used In                                                         | Notes                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entries.list` (infinite)       | `EntryList`, `EntryListContainer`, `UnifiedEntriesContent`      | `staleTime: Infinity`                                                                                                                                                                                                                                                                                                            |
| `entries.get`                   | `EntryContent`                                                  | Single entry with full content. Its `fetchFullContent` is used only when the store doesn't hold the subscription                                                                                                                                                                                                                 |
| `subscriptions.get`             | `UnifiedEntriesContent`, `useSidebarSelection`                  | Loads one subscription into the store (the route title and the open subscription render from the store); deleting the subscription resets it.                                                                                                                                                                                    |
| `entries.countLists`            | `Sidebar`                                                       | The All, Starred and Saved badges (and Uncategorized's) from one read, rendered from the store                                                                                                                                                                                                                                   |
| `subscriptions.list` (infinite) | `TagSubscriptionList` (sidebar)                                 | Loads a sidebar section's pages (`{ tagId }` or `{ uncategorized }`) into the store; the section renders from the store, limited to what these pages cover. Never written directly. `CollectionsButton` also searches collections with `{ type: "collection" }`; `useSavedSubscriptionId` reads `SAVED_SUBSCRIPTION_LIST_INPUT`. |
| `tags.list`                     | `Sidebar`, `EditSubscriptionDialog`, `TagManagement`, tag pages | All tags with their unread counts and Uncategorized's, rendered from the store                                                                                                                                                                                                                                                   |

`sortBy: "readChanged"` backs the `/recently-read` view (entries sorted by `read_changed_at` rather than publish time; defaults to `unreadOnly=false`). It and search (`query`) lists get **no** live inserts: `insertIntoMatchingLists` (`src/lib/local-db/entry-lists.ts`) skips any list whose input has a `query` or a `sortBy` other than `"published"`, because their ordering (relevance rank / read-time) can't be derived from an entry's fields. Those views instead refresh on navigation like any other list.

Search (`?q=`) is an ordinary `entries.list` scoped to the current view's filters. With a query present, `unreadOnly` defaults to `false` and sort order is canonicalized in the input, since results are ranked by relevance and a stray `?sort=` must not fragment the cache key.

## Mutations

### Entry Mutations (`useEntryMutations`)

| Mutation                   | Cache Updates                                                                                                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entries.markRead`         | Optimistic transaction on the entry store (mark-unread also inserts the entry into unread-only lists missing it); the response goes through `applyEntryStateChanges`                                                                                           |
| `entries.setStarred`       | Optimistic transaction on the entry store; the response goes through `applyEntryStateChanges`                                                                                                                                                                  |
| `entries.markAllRead`      | `handleMarkAllRead`: absolute `counts` from the response, and invalidate `entries.list` (bulk operation, too many entries to patch). The server also publishes one `mark_all_read` SSE event with the same counts, applied the same way by other tabs/devices. |
| `entries.fetchFullContent` | Direct: patch `entries.get({ id })` with the returned `result.entry` (`useFullContent`; ingested into the store like any `entries.get` result). Only when the response has no `entry` does it fall back to `invalidate({ id })`.                               |

### Subscription Mutations

| Mutation                | Used In                                    | Cache Updates                                                                                        |
| ----------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `subscriptions.create`  | Subscribe page                             | `handleSubscriptionCreated`: add to the store + set absolute `counts` from response (`onSuccess`)    |
| `subscriptions.update`  | `useFullContent`, `EditSubscriptionDialog` | `applySubscriptionUpdate` with the returned row                                                      |
| `subscriptions.delete`  | `Sidebar`, Broken feeds                    | Optimistic remove (`onMutate`); `handleSubscriptionDeleted` with the response's counts (`onSuccess`) |
| `subscriptions.setTags` | `EditSubscriptionDialog`                   | `applySubscriptionUpdate` with the returned row                                                      |
| `subscriptions.import`  | `OpmlImportExport`                         | Toast + navigate; `import_progress`/`import_completed` SSE events invalidate `imports.*`             |
| `imports.preview`       | `OpmlImportExport`                         | None (pure server-side OPML parse for the preview list; no cached data changes)                      |

Collection mutations (`useCollectionMembership`): `collections.addEntries` / `removeEntries` apply the response through `applyCollectionEntriesChange`; `collections.create` goes through `handleSubscriptionCreated` when it created the collection; when it returned an existing one (`created: false`), the entry is added with `collections.addEntries` and applied through `applyCollectionEntriesChange` only. Deleting a collection is `subscriptions.delete`. An ebook import (`collections.importEbook`, in `FileUploadButton`) applies its collection like `collections.create` (`handleSubscriptionCreated` when created, else `applyUnreadCounts`) and navigates to it; its chapters reach loaded lists through their `new_entry` and `collection_entries_changed` events.

Tag mutations (`tags.create/update/delete`, in `TagManagement`) apply their responses through `applyTagChange`/`applyTagDeleted`, as their events do.

`saved.uploadFile` (`FileUploadButton`) applies the response's `listItem` and counts through `applyNewEntry`, as the upload's `new_entry` event does. Uploading into a collection files the article after inserting it, so the server reads the response's `listItem` after filing it: as fresh as the collection's event, and naming the collection.

Preference changes (`users.me.updatePreferences`) all go through `usePreferenceMutation`: the response replaces `me.preferences`, and the hook invalidates the queries derived from what changed, so a panel names only its toasts.

No-op re-saves publish no `subscription_updated` ("Row Written vs. Value Flipped" in `src/server/CLAUDE.md`); the acting tab still updates its own cache.

## Real-Time Updates

`useRealtimeUpdates` manages the SSE connection (polling fallback via `sync.events`) and feeds every event through `handleSyncEvent`.

**Key principle:** SSE events write the local store and caches directly and must NOT trigger `entries.*` refetches (enforced by e2e tests via `recordTrpcProcedures`). Counts are always set to absolute server-provided values (idempotent — duplicate SSE/sync delivery can't drift them). The **two deliberate exceptions** are `mark_all_read` and `subscription_deleted`: both change unboundedly many entries (every one marked, or every one of the subscription's, plus the saved articles deleted with a collection), so patching each (or shipping every id) isn't worth it, and they invalidate `entries.list` instead — a rare cost for a deliberate bulk action. They invalidate directly rather than through `refreshEntryLists`, so a fetch already in flight (which predates the change) is re-run; the acting tab, which applies both the response and the event, may refetch twice.

**Another deploy's server:** every stream opens with a `hello` naming the server's build (`BUILD_ID`). When it is later than the page's, `RealtimeProvider` turns the next client-side navigation into a full page load, so a tab left open across a deploy picks up the new JavaScript. Events from the newer server still apply in the meantime, so event schemas still tolerate fields one release apart.

**Catch-up sync after (re)connect (#1081):** on SSE `open`, `useRealtimeUpdates` runs a catch-up sync against `sync.events` from the current cursors. Its decisions live in the pure reducer `reduceSyncSession` (`src/lib/events/sync-session.ts`), which upholds these invariants so it can't lose changes made while disconnected:

- **Retry on failure.** A failed catch-up sync is retried with exponential backoff (2s→30s) even in the `connected` phase (the `polling` phase already retries every 30s). Without the retry, one failure would strand the gap on an idle view.
- **Cursor freeze until caught up.** Live SSE events patch the cache immediately but do **not** advance the persisted sync cursor until the connection's catch-up sync has fully succeeded (`caughtUp`). Otherwise a live event would push the cursor past the not-yet-synced gap, making the pending/retrying catch-up query skip the gap's rows. The catch-up sync itself always advances the cursor (it drains the authoritative server sequence). Any stream error (including the browser's silent EventSource auto-reconnect) re-freezes the cursor so the next catch-up re-covers whatever was missed.
- **Hold the catch-up's start (#1663).** Every page of a catch-up sends where it started as `entriesSince`, so an entry pushed onto a later page by a newer change still gets its earlier `new_entry`/`entry_updated`. The start is cleared only when a page reports no more — deliberately kept through failures and reconnects, since an older start only re-reports changes (harmless) while a newer one loses them.

| SSE Event                    | Cache Updates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new_entry`                  | `applyNewEntry`: absolute counts; stores the event's `entry` payload and inserts it into matching loaded lists via `addServerEntryToLists`, placed by the event's `subscriptionIds` and `tagLists` (Saved through the saved subscription, looked up on a first save; skips search/unknown-filter lists and entries beyond the loaded pagination window). The payload's `type` is display only; its `feedTitle` gives way to a stored subscription's custom title. Spam entries carry no payload. Idempotent (absolute counts, insert deduped by ID).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `entry_updated`              | Direct: the stored entry's metadata (title, author, summary, url, publishedAt; skipped when older than the stored metadata), which the reader renders too. No invalidation — avoids a race when the entry is open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `entry_state_changed`        | `applyEntryStateChanges`: the stored entry's read/starred, `subscriptionIds`, `tagLists`, and `score` and `positions` when sent (skipped when older than the stored state; a score or position turns on the sort in the lists it reaches) and absolute counts. Entries becoming unread are inserted into the lists missing them: events for unread flips carry a list-item payload (like `new_entry`; omitted for spam) — so the entry appears even when the store doesn't hold it (marked unread on another device/MCP, issue #1237); payload-less events (star/unstar of an unread entry) fall back to the stored row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `mark_all_read`              | A `markAllRead` happened on another tab/device: `handleMarkAllRead`, as the acting tab does (absolute counts). Its `entries.list` invalidation is one of the two deliberate list refetches (see Key principle above). Advances the entries cursor so a reconnect catch-up doesn't re-deliver every marked entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `subscription_created`       | Add its `row` to the store; absolute counts from server `counts` (live path). The sync.events catch-up path omits `counts`, so the client invalidates `tags.list` + `entries.countLists` instead. A previous release's event (during a deploy) has no `row`: the client fetches the subscription (`subscriptions.get`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `subscription_updated`       | `applySubscriptionUpdate`: write its `row` (it moves between sections) and set its stored entries' `feedTitle`; invalidate `tags.list` (feed counts) when its tags changed. Without a `row`, fetch it as for `subscription_created`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `subscription_deleted`       | `handleSubscriptionDeleted`: remove from the store and from stored entries' `subscriptionIds`, and reset its `subscriptions.get`; absolute counts (live path) or invalidate `tags.list` + `entries.countLists` (catch-up); invalidate `entries.list` (a deliberate list refetch, see Key principle above). Runs in full even when the store doesn't hold it (optimistically removed, or never loaded with tags collapsed; #1081).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `collection_entries_changed` | `applyCollectionEntriesChange`: absolute counts, the stored entry's `subscriptionIds` and `positions` (a state write as of the change's `updatedAt`, the entries' new `user_entries.updated_at`, which the mutation response carries too: a page or response read before the change can't revert it, and a change older than the stored state yields to it), and the loaded lists (the collection's and tag/Uncategorized ones by the event's `tagLists`; adds inserted from the store, at the positions the event carries, removals hidden; "Membership never follows state"). SSE-only: a catch-up sync re-delivers the entries (with their `subscriptionIds`) as `entry_state_changed`; when one may have changed memberships (`mayChangeMemberships`: they differ from the stored entry's, or the store lacks it; a page fetched while disconnected that already shows the change hides it, and a collection it left keeps its stale count until a count-bearing event or reload), the catch-up's end (`refresh-memberships` in `sync-session.ts`) invalidates `subscriptions.list` and `tags.list`, and refetches the stored collections with unread entries (`refreshStoredCollections`: a collection an article left gets no replayed count); the collection's lists catch up on navigation. |
| `tag_created`                | `applyTagChange`: write the stored tag (a new one has no feeds)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tag_updated`                | `applyTagChange`: the stored tag, and its name and color on the stored subscriptions carrying it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tag_deleted`                | `applyTagDeleted`: remove the tag and its count, take it off the stored subscriptions (which may move them to Uncategorized), and invalidate `tags.list` for Uncategorized's count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `import_progress`            | Invalidate: `imports.get({ id })`, `imports.list`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `import_completed`           | Invalidate: `imports.get({ id })`, `imports.list`. Entry/subscription changes arrive as individual events during import.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `announcement_changed`       | **Global broadcast** (site-status channel, not per-user): the admin changed the announcement banner. No React Query cache is touched — it calls `setLiveAnnouncement` (`@/lib/site-status/announcement-store`), a module store the SPA-layout (`src/app/(spa)/(app)/layout.tsx`) `AnnouncementBanner` subscribes to via `useSyncExternalStore`. `announcement` is null when disabled/cleared (hides the banner). Not part of the `sync.events` catch-up (SSE-only), so a change during a disconnect is picked up on the next full page load.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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

A control that must react at once (a switch) may render the mutation's pending
variables until the response lands (`usePreferenceMutation`'s `pendingUpdate`):
nothing is written to a cache, so a failure has nothing to roll back.

### Auto-mark-read (EntryContent)

Opening an entry fires `markRead` once, as soon as `entries.get` data is available (straight from cache when a prefetch warmed it, otherwise when the fetch lands) — even for an already-read entry, so its `readChangedAt` moves it to the top of Recently Read. The optimistic update shows read state instantly, and the `updatedAt` guard resolves it against any `entries.get` fetch still in flight.

## Mutation Response Shapes

Mutations return everything cache updates need (the client never derives counts locally); see the procedures' output schemas for the shapes.

`counts` is **absent when no value actually flipped** (a same-value re-assert;
"Row Written vs. Value Flipped" in `src/server/CLAUDE.md`), and such a write
publishes no `entry_state_changed`. Apply counts only when present; absent means
the stored counts are already correct.

## Adding New Cache Updates

1. **Entries**: write the local store through the `updatedAt`-guarded functions in `src/lib/local-db/entries.ts`, and add entries to lists with `insertEntryIntoLists`/`addServerEntryToLists`; never write entry state to `entries.list`/`entries.get`, and never trigger a list refetch from an event — lists refresh on navigation (`useEntryListRefreshOnNavigate`).
2. **Subscriptions**: write the store through `src/lib/local-db/subscriptions.ts`'s live writes; never write `subscriptions.list`/`subscriptions.get` data.
3. **Everything else**: if it's shown live, give it a collection in the local store fed from its query, and write responses and events through one `src/lib/cache/operations.ts` function; otherwise invalidate.
4. **Unread counts**: apply absolute server-provided counts, stamped with `asOf`, via `applyUnreadCounts` (idempotent, newest wins — never deltas). A new count-bearing output stamps its counts (`countsAsOfColumn`).
5. **Handle races**: check existence before add/remove; SSE may deliver the same update as the mutation response.
6. **Update this document** and add unit tests in `tests/unit/frontend/local-db/` or `tests/unit/frontend/cache/`.
