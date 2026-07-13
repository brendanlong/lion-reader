-- Index entries(feed_id, updated_at) for the sync.events delta rewrite (#1105).
--
-- sync.events used to filter and sort on GREATEST(entries.updated_at,
-- user_entries.updated_at) — a value spanning two tables, so no index could
-- serve it and every call scanned + sorted the user's entire history. The
-- rewrite splits the delta into index-driven arms and UNIONs them; the
-- entry-side arm (content refetches that bump entries.updated_at WITHOUT
-- touching the user_entries row) needs to seek changed entries within a feed:
--
--   entries.feed_id = <subscribed feed> AND entries.updated_at >= cursor
--
-- This index serves that seek. It also serves the saved-articles arm, which
-- keys on the user's saved feed id directly (saved feeds are never polled, so
-- their feeds.last_entries_updated_at stays NULL and can't pre-filter them).
--
-- NOTE: on a large `entries` table, build this CONCURRENTLY out-of-band first
-- (CREATE INDEX CONCURRENTLY can't run inside the migration runner's
-- transaction); this IF NOT EXISTS statement then no-ops there and only builds
-- the index on databases that don't have it yet.

CREATE INDEX IF NOT EXISTS idx_entries_feed_updated_at
  ON entries (feed_id, updated_at);
