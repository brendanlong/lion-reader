-- Denormalize the timeline sort key onto user_entries.
--
-- The main timeline list query (listEntries) filters on user_entries.user_id but
-- sorts by entries.COALESCE(published_at, fetched_at) DESC, id DESC. Because the
-- filter and sort columns lived on different tables, no single index could cover
-- both, so an unfiltered "All" view forced Postgres to read a user's entire
-- user_entries set, join entries, and sort — degrading ~linearly with entry count.
--
-- COALESCE(published_at, fetched_at) is immutable per entry: createEntry sets both
-- columns once and updateEntryContent never touches them. So we can safely copy the
-- value onto user_entries at insert time and index (user_id, sort_key DESC, id DESC),
-- giving the planner an index it can walk in sort order with LIMIT pushdown while
-- only touching the target user's rows.
--
-- A BEFORE INSERT trigger fills the column from entries when a caller omits it, so
-- every insert path (drizzle inserts, tests, seeds) stays correct without changes.
-- The hot bulk paths (feed processing, subscribe) populate it inline to avoid the
-- per-row lookup, so the trigger is a no-op there.

ALTER TABLE user_entries ADD COLUMN published_or_fetched_at timestamptz;
--> statement-breakpoint
UPDATE user_entries ue
SET published_or_fetched_at = COALESCE(e.published_at, e.fetched_at)
FROM entries e
WHERE e.id = ue.entry_id;
--> statement-breakpoint
ALTER TABLE user_entries ALTER COLUMN published_or_fetched_at SET NOT NULL;
--> statement-breakpoint
CREATE FUNCTION user_entries_fill_sort_key() RETURNS trigger AS $$
BEGIN
  IF NEW.published_or_fetched_at IS NULL THEN
    SELECT COALESCE(e.published_at, e.fetched_at)
      INTO NEW.published_or_fetched_at
      FROM entries e
      WHERE e.id = NEW.entry_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER user_entries_fill_sort_key_trigger
  BEFORE INSERT ON user_entries
  FOR EACH ROW
  EXECUTE FUNCTION user_entries_fill_sort_key();
--> statement-breakpoint
CREATE INDEX idx_user_entries_published_or_fetched
  ON user_entries (user_id, published_or_fetched_at DESC, entry_id DESC);
--> statement-breakpoint
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
    ue.score,
    ue.has_marked_read_on_list,
    ue.has_marked_unread,
    ue.has_starred,
    s.id AS subscription_id,
    esp.predicted_score,
    esp.confidence AS prediction_confidence,
    e.unsubscribe_url,
    ue.read_changed_at,
    e.wallabag_id,
    ue.published_or_fetched_at
   FROM ((((user_entries ue
     JOIN entries e ON ((e.id = ue.entry_id)))
     LEFT JOIN subscription_feeds sf ON (((sf.user_id = ue.user_id) AND (sf.feed_id = e.feed_id))))
     LEFT JOIN subscriptions s ON ((s.id = sf.subscription_id)))
     LEFT JOIN entry_score_predictions esp ON (((esp.user_id = ue.user_id) AND (esp.entry_id = e.id))))
  WHERE ((s.unsubscribed_at IS NULL) OR (ue.starred = true));
