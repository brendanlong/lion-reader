-- Persist sanitized entry HTML so entries.get serves it directly instead of
-- re-running sanitize-html on every read. Sanitizing a large body is the
-- dominant cost of entries.get (~50ms per ~700KB, across up to four content
-- fields), and it was paid on every open of the same entry.
--
-- Sanitized output is a pure function of (raw HTML, sanitizer allow-list), so we
-- store it in columns alongside the raw content and stamp the SANITIZER_VERSION
-- it was produced with. The read path serves the stored value when its version
-- matches the current SANITIZER_VERSION, and lazily re-sanitizes (self-heals)
-- otherwise. Tightening the allow-list is therefore just a version bump: every
-- row's cached output is treated as stale and regenerated on next read (or by a
-- backfill). Raw content is kept so re-sanitization never needs a re-fetch.
--
-- Two version columns mirror the two content lifecycles already tracked by
-- content_hash / full_content_hash: feed content is written at create/update,
-- full content is written later at fetch time.

ALTER TABLE entries
  ADD COLUMN content_original_sanitized text,
  ADD COLUMN content_cleaned_sanitized text,
  ADD COLUMN content_sanitized_version smallint,
  ADD COLUMN full_content_original_sanitized text,
  ADD COLUMN full_content_cleaned_sanitized text,
  ADD COLUMN full_content_sanitized_version smallint;
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
    ue.published_or_fetched_at,
    e.content_original_sanitized,
    e.content_cleaned_sanitized,
    e.content_sanitized_version,
    e.full_content_original_sanitized,
    e.full_content_cleaned_sanitized,
    e.full_content_sanitized_version
   FROM ((((user_entries ue
     JOIN entries e ON ((e.id = ue.entry_id)))
     LEFT JOIN subscription_feeds sf ON (((sf.user_id = ue.user_id) AND (sf.feed_id = e.feed_id))))
     LEFT JOIN subscriptions s ON ((s.id = sf.subscription_id)))
     LEFT JOIN entry_score_predictions esp ON (((esp.user_id = ue.user_id) AND (esp.entry_id = e.id))))
  WHERE ((s.unsubscribed_at IS NULL) OR (ue.starred = true));
