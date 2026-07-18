-- Full-text search index for entries (#1249).
--
-- Search had no index at all: searchEntries computed to_tsvector over every
-- visible body on the fly for both the `@@` match and the ts_rank sort, so each
-- search seq-scanned and tokenized the user's whole history (multiple seconds).
-- This adds a STORED generated tsvector column + a GIN index; searchEntries now
-- reads the column for both the match and the rank, so nothing re-tokenizes.
--
-- Search document: title + the readability-cleaned body, falling back to the raw
-- content_original when the cleaned column is empty (~95% of rows here have an
-- empty content_cleaned, so without the fallback content search would be
-- title-only for almost everything). NULLIF(content_cleaned, '') makes the
-- fallback fire for a whitespace-empty cleaned column too, not just SQL NULL
-- (the feed processor stores NULL, but this is defensive against other insert
-- paths). content_original is raw HTML, so a few markup tokens leak into the
-- vector — acceptable noise for search.
--
-- 1 MB guard: to_tsvector errors ("string is too long for tsvector") once a
-- single document's vector would exceed 1 MB. For a GENERATED column that error
-- fires at INSERT/UPDATE time, so an un-capped expression would both fail this
-- ALTER (on the 8 prod rows already over 1 MB of text) and permanently break
-- ingestion of any future oversized entry. left(..., 300000) caps the input at
-- 300k chars; the worst realistic case (all-distinct short tokens) tokenizes at
-- ~2.4 bytes/char, so the vector stays ~740 KB — safely under the limit with
-- margin. The untokenized tail of an enormous article is not searchable, which
-- is irrelevant at the p99 body size of ~10 KB.
--
-- REWRITE COST: the generated value is materialized for every existing row when
-- the column is added, which rewrites the entries table under an ACCESS
-- EXCLUSIVE lock. On ~300k rows / ~150 MB of text this is on the order of tens
-- of seconds; run the deploy that ships this migration under maintenance mode so
-- the old app isn't reading entries mid-rewrite. If entries ever grows too large
-- for a rewrite, switch to a plain tsvector column + trigger + batched backfill
-- (see #1249) — searchEntries would be unchanged.
ALTER TABLE entries
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      left(COALESCE(title, '') || ' ' || COALESCE(NULLIF(content_cleaned, ''), content_original, ''), 300000)
    )
  ) STORED;

--> statement-breakpoint

-- GIN index over the stored vector. On a large entries table build this
-- CONCURRENTLY out-of-band first (CREATE INDEX CONCURRENTLY can't run inside the
-- migration runner's transaction — see migrations/CLAUDE.md); this IF NOT EXISTS
-- statement then no-ops there and only builds the index on databases that don't
-- have it yet. (Under the maintenance window above, the inline non-concurrent
-- build on a fresh DB is a few seconds.)
CREATE INDEX IF NOT EXISTS idx_entries_search_vector ON entries USING gin (search_vector);

--> statement-breakpoint

-- Expose the stored vector through visible_entries so searchEntries can read it
-- for the `@@` match and the ts_rank sort. The column is APPENDED so CREATE OR
-- REPLACE VIEW is valid, and old code simply ignores it (expand/contract-safe).
CREATE OR REPLACE VIEW visible_entries AS
 SELECT ue.user_id,
    e.id,
    e.feed_id,
    e.type,
    e.guid,
    e.url,
    e.title,
    e.author,
    e.content_original,
    e.content_cleaned,
    e.summary,
    e.site_name,
    e.image_url,
    e.published_at,
    e.fetched_at,
    e.last_seen_at,
    e.content_hash,
    e.full_content_hash,
    e.spam_score,
    e.is_spam,
    e.list_unsubscribe_mailto,
    e.list_unsubscribe_https,
    e.list_unsubscribe_post,
    e.created_at,
    GREATEST(e.updated_at, ue.updated_at) AS updated_at,
    e.full_content_original,
    e.full_content_cleaned,
    e.full_content_fetched_at,
    e.full_content_error,
    ue.read,
    ue.starred,
    s.id AS subscription_id,
    e.unsubscribe_url,
    ue.read_changed_at,
    ue.published_or_fetched_at,
    e.greader_item_id,
    s.greader_stream_id AS subscription_greader_stream_id,
    e.search_vector
   FROM ((user_entries ue
     JOIN entries e ON ((e.id = ue.entry_id)))
     LEFT JOIN subscriptions s ON ((s.id = ue.subscription_id)))
  WHERE (((s.id IS NOT NULL) AND (s.unsubscribed_at IS NULL)) OR (ue.starred = true) OR (e.type = 'saved'::feed_type));
