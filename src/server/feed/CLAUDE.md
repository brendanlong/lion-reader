# Feed Fetching & WebSub (`src/server/feed/`)

Pipeline diagram: `docs/diagrams/feed-fetcher.d2`. Scheduling and backoff are in `scheduling.ts`.

## Fetching

- **A 404/410 doesn't mean the feed is gone** (YouTube 404s every feed for hours most days, #1114): it takes the ordinary failure backoff, and one success resets it.
- **Rate limiting isn't breakage**: 429 backoff is capped at 6 hours, and `Retry-After` is honored as a floor.
- A plugin can raise its source's minimum poll interval (`FeedCapability.minFetchIntervalSeconds`; YouTube rate-limits RSS per IP).
- The fetch/write paths store raw content; sanitization happens on read (`src/server/html/CLAUDE.md`).
- The global "some feed fetched successfully lately" alert lives in `health.ts`.

## Entry identity

Entries are keyed on `(feed_id, guid)`, but feed guids compare **http/https-insensitively** and the stored guid is never rewritten (`guid-identity.ts` says why). **Compare feed-entry guids across rows only through its helpers** — a raw `guid = guid` reintroduces #1535's duplicates. The partial unique index `uq_entries_feed_guid_canonical` enforces the same rule in the database.

## Backfill Guard

A first-sighted entry published well before the previous full fetch is an archive re-announcement, not news (`isBackfilledEntry` explains the rule, threshold and accepted risk). The verdict is persisted as `entries.is_backfill`, and **every path that grants visibility copies it into `user_entries.read`** — the fetch fanout, its self-heal, and the subscribe-time populate. A new visibility path must do the same.

## WebSub

Feeds with a hub get pushes and drop to a 24h backup poll. Mechanics are in `websub.ts` and `websub-notification.ts`; the rules that keep a silently dead hub from leaving a feed stale:

- **A push is not a full fetch**: it never advances `feeds.last_fetched_at` or `last_entries_updated_at` (subscribe-time visibility and staleness depend on them), and it clears `body_hash` so the next poll reprocesses.
- **A push defers the backup poll only up to `last_fetched_at` + the backup interval**, never "now + interval", or a hub pushing more than daily would prevent polling forever.
- **`entries.last_seen_at` only moves forward**, because pushes run outside the job queue's per-feed serialization.
- A parseable push that fails to ingest answers 503 so the hub redelivers; re-ingesting is idempotent.
- Pushed entries get full content through the feed's pending `fetch_full_content` job, never inline in the callback.
- **Renewal never disrupts an active subscription**: the row stays `active` and `callback_secret` never rotates. A subscription the hub never re-verifies reverts to polling only after `RENEWAL_STALL_GRACE_MS` **and** proof that we retried (`updated_at > expires_at`), via compare-and-swap (#1079).
- Leases are clamped to 14 days (`MAX_LEASE_SECONDS`), and `websub_hub_stats` tallies per hub how new articles reached us, so a hub that accepts subscriptions but never pushes shows up.
