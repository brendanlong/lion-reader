# Feed Fetching & WebSub (`src/server/feed/`)

Pipeline diagram: `docs/diagrams/feed-fetcher.d2`. Scheduling and backoff are in `scheduling.ts`.

## Fetching

- **A 404/410 doesn't mean the feed is gone** (YouTube 404s every feed for hours most days, #1114): it takes the ordinary failure backoff, and one success resets it.
- **Rate limiting isn't breakage**: 429 backoff is capped at 6 hours, and `Retry-After` is honored as a floor.
- A plugin can raise its source's minimum poll interval (`FeedCapability.minFetchIntervalSeconds`; YouTube rate-limits RSS per IP).
- The fetch/write paths store raw content; sanitization happens on read (`src/server/html/CLAUDE.md`).
- The global "some feed fetched successfully lately" alert lives in `health.ts`.

## Entry identity

Web entries are keyed on `(owner_feed_id, guid)` (#1846), but feed guids compare **http/https-insensitively** and the stored guid is never rewritten (`guid-identity.ts` says why). **Compare feed-entry guids across rows only through its helpers** — a raw `guid = guid` reintroduces #1535's duplicates. The partial unique index `uq_entries_owner_feed_guid_canonical` enforces the same rule in the database.

## Backfill Guard

An entry published well before the feed's previous full fetch is an archive re-announcement, not news, and is linked already read to subscribers who were subscribed at that fetch; everything is news to anyone who subscribed since (`isBackfilledEntry` explains the rule, threshold and accepted risk). **The verdict belongs to the link, not the entry** (#2036): the fan-out judges it per subscription (`linksReadSql`) — never store it on the entry, or an article re-announced long after it was first seen keeps its first verdict. A new linking path that reaches existing subscribers must judge it the same way.

## WebSub

Feeds with a hub get pushes and drop to a 24h backup poll. Mechanics are in `websub.ts` and `websub-notification.ts`; the rules that keep a silently dead hub from leaving a feed stale:

- **A push vouches for an entry only until the next poll.** It inserts, updates and fans out to current subscribers, and stamps `entries.pushed_at` on every entry it announces, but never writes `last_seen_at` or the poll state (`last_fetched_at`, `last_entries_updated_at`, `body_hash`). A new subscriber gets a pushed entry while `pushed_at > last_fetched_at`; the next poll stamps it or, if the feed doesn't list it, drops it. A failed poll counts too (it advances `last_fetched_at`), so pushed entries stop being granted until a successful poll lists them: that errs toward granting less. So a push needs no coordination with a concurrent poll (#1959).
- **`pushed_at` and `last_fetched_at` come from the database clock** (`databaseNow`): pushes and polls run on different machines, and a poll takes it after the response arrives, never before the fetch it records.
- **A push defers the backup poll only up to `last_fetched_at` + the backup interval**, never "now + interval", or a hub pushing more than daily would prevent polling forever.
- A parseable push that fails to ingest answers 503 so the hub redelivers; re-ingesting is idempotent.
- Pushed entries get full content through the feed's pending `fetch_full_content` job, never inline in the callback.
- **Renewal never disrupts an active subscription**: the row stays `active` and `callback_secret` never rotates. A subscription the hub never re-verifies reverts to polling only after `RENEWAL_STALL_GRACE_MS` **and** proof that we retried (`updated_at > expires_at`), via compare-and-swap (#1079).
- Leases are clamped to 14 days (`MAX_LEASE_SECONDS`), and `websub_hub_stats` tallies per hub how new articles reached us, so a hub that accepts subscriptions but never pushes shows up.
