# Backend Guidelines (`src/server/`)

Diagram: `docs/diagrams/backend-api.d2`. The decisions behind the data model are in `docs/DESIGN.md`; this file holds the rules for working with it.

## Services Layer

Business logic shared by tRPC routers, the MCP server, the compat APIs and background jobs lives in `src/server/services/` as plain functions that take `db` plus parameters and return plain data, named `verbNoun` (`listEntries`, `markEntriesRead`). Routers, tools and job handlers stay thin.

## New-Account Onboarding

Everything a new account gets goes in `runPostSignupTasks` (`src/server/auth/signup.ts`), which both signup paths call — **add steps there, not in the routes**, or the paths drift. Each task swallows its own errors; none may fail a signup.

## Site Status

The announcement banner and maintenance mode live in **Redis, not Postgres**, because maintenance mode has to work while the database is locked (`services/site-status.ts`). They are the source of truth, not a cache, so **nothing may `flushdb()`** — the deploy-time clear skips their prefix (`redis/clear-cache.ts`). The maintenance gate is in the custom server (`maintenance/server-gate.ts`); the worker and Discord bot stop touching the DB while it's on.

## Views

- **`user_feeds`**: active subscriptions merged with feed data, including `unread_count`. **Display-only** — ownership/scoping checks query `subscriptions` directly. When grouping over a view, list every selected column in `GROUP BY`: Postgres doesn't infer functional dependencies through views (#1516).
- **`visible_entries`**: entries with visibility applied, for `entries.list/get`. Unread counts don't scan it; they read the counters (`services/counts.ts`).

## Entry Visibility

An entry is visible iff a `user_entries` row exists for `(user, entry)` and the entry is from an active subscription, starred, a saved article, or in one of the user's collections. The saved-article arm gates on entry **type**, never on `subscription_id IS NULL`, so the view fails closed. `sync.ts` (`visibleEntrySql`) repeats the predicate; change both together.

**The insert paths, not the view, keep pre-subscription content private**, so any new path that creates `user_entries` rows must only cover entries currently in the feed:

- **Subscribe time** (`populateInitialUserEntries`, for `createSubscription` and a redirect merge's survivor): entries with `last_seen_at >= feeds.last_entries_updated_at` (`>=` so WebSub-pushed entries count; #1078). A stale feed instead gets a forced background refresh that fans out from a fresh fetch.
- **Fetch time** (`entry-processor.ts`): every entry in the current fetch, idempotently, so a crash between insert and fanout self-heals on the next fetch. Archive re-announcements fan out already read ("Backfill Guard" in `feed/CLAUDE.md`).

Starring is itself a visibility arm, so **never read a star write back through `visible_entries`** — unstarring an entry from an unsubscribed feed drops it from the view and the write looks like "not found". Read back from `user_entries` (`selectStarredEntryStates`).

## Subscription Attribution

`user_entries.subscription_id` (NULL for saved/uploaded articles) is the **sole** link from an entry to its source subscription; `visible_entries` and every subscription/tag filter resolve through it. Bulk insert paths set it inline, a `BEFORE INSERT` trigger fills it (and `is_spam` and the timeline sort key) for everything else, and a feed-redirect merge (`mergeSubscriptionIntoFeed`) re-stamps it. Don't reintroduce a junction table for sources: the column exists to avoid the `DISTINCT` dedup a junction forces (#1117).

A subscription's kind is its own `subscriptions.type` (#1846): read it there, never by joining `feeds`. A **collection** (#1806) is a subscription of type `collection` (to a per-user feed that has no entries of its own); its members live in `collection_entries`. Its name is `subscriptions.custom_title`, unique among the user's active collections ignoring case; the database enforces that (a unique index), and code only maps the violation to `COLLECTION_NAME_TAKEN`. Test for one with `isCollectionSubscription()` (or for a web feed, `isWebSubscription()`; both in `services/subscriptions.ts`). Filter "entries in these subscriptions" with `buildEntriesInSubscriptionsCondition` (`services/entry-filters.ts`), which adds the membership arm as an `EXISTS` (no row fan-out, so still no `DISTINCT`). Membership changes move `user_entries.updated_at`, so delta sync re-delivers the entry.

## Unread Counts

Every badge reads one trigger-maintained counter (spam excluded; the list is in `services/counts.ts`). Tag, Uncategorized and All count **distinct** articles, since an article can reach them through both its feed and a collection; the database functions `apply_unread_rows` and `recompute_list_counters` say how they're maintained. **All counter maintenance lives in the triggers** — never update a counter from app code. **Lock order is `user_entries` rows, then subscriptions, then users (sorted by id, `FOR NO KEY UPDATE`), then tags**, in triggers and app code alike: a transaction that changes tags, subscriptions or memberships across statements takes its locks in that order first (`lockSubscriptionRow`, `lockUserEntryRows`) or it deadlocks against a concurrent mark-read. Add any new operation that moves a counter to the `OPS` of `tests/integration/list-counters-model.test.ts`. The daily `reconcile_counters` job repairs drift and logs each fix at error level — **a fix means a trigger bug to investigate.**

## Row Written vs. Value Flipped

- `read_changed_at` / `starred_changed_at` are last-writer-wins watermarks: a mutation applies only if its `changedAt` (mapped to server time by `toServerTime`, capped at now) is newer. They advance on **every** accepted write, including a same-value re-assert, or a late replay could win (#1118).
- `user_entries.updated_at` moves **only on a real flip**, and so do the user-facing side effects: count aggregation, the `entry_state_changed` publish, and delta-sync redelivery (`sync.events`, Wallabag `since`). Re-asserts return no `counts`.
- The same "no churn on a non-meaningful write" rule covers entries (unchanged `content_hash` doesn't bump `updated_at`; #1084) and subscriptions (`update`/`setTags`/Google Reader rename publish and bump `updated_at` only on a real change; #1160). Capture the pre-update value in the UPDATE itself (`... AS prev` self-join), not with a pre-SELECT.

## Deletions in Delta Sync

Deltas key off `updated_at`, so a hard delete is invisible to them. **Hard-deleting an entry a client may hold must record an `entry_tombstones` row in the same transaction** (`services/entry-tombstones.ts`).

## Ordering & Pagination

- The timeline sorts by `COALESCE(published_at, fetched_at)`, denormalized onto `user_entries.published_or_fetched_at` so one index serves filter and sort. UUIDv7 `id` is only the tiebreaker.
- Build cursors with `createCursorCodec` (`services/cursor.ts`), never by hand.
- **Timestamp cursors need microseconds**: a JS `Date` truncates to milliseconds and drops or repeats rows sharing one (#680). Use `parseTimestamptz` / the `temporalTimestamp` column type (`db/temporal.ts`), and compare cursors with `Temporal.Instant.compare` (#683).

## Compat API Integer IDs

Every integer id a Google Reader or Wallabag client sees is a **stored serial** (`entries.greader_item_id`, `subscriptions`/`feeds.greader_stream_id`, `tags.greader_sortid`, `users.greader_user_id`). **Never derive one by hashing or truncating a UUID** — that had real collisions (#1117). Subscription and feed stream ids share one sequence, so a `feed/{int}` resolves to at most one of them; saved articles appear to Google Reader as a synthetic "Saved Articles" subscription keyed by the saved feed's serial (#730). Resolvers that reverse a client-supplied id are user-scoped (SECURITY.md §8).
