-- Drop the deprecated entries.*_sanitized columns (issue #1289, phase 3 of #1282).
--
-- Sanitization became per-read in #1282/#1288: the persisted sanitized columns
-- (content_original_sanitized, content_cleaned_sanitized, content_sanitized_version,
-- and the full_content_* equivalents) are no longer read or written. Per the
-- expand/contract rule they were kept for one release so the previous release
-- (which re-sanitizes from raw when the stored version is NULL) could still serve
-- content on a rollback. That release has shipped, so this is the contract step.
--
-- Expand/contract: safe for the previous (now-current) release. It selects
-- explicit column lists everywhere (never SELECT *), no longer reads or writes
-- these columns, and its Drizzle definitions of entries and visible_entries no
-- longer reference them. visible_entries must be dropped and recreated because a
-- column can't be dropped out from under a view.
--
-- Reclaims roughly half of the entry-content TOAST storage.

DROP VIEW visible_entries;

--> statement-breakpoint

ALTER TABLE entries
  DROP COLUMN content_original_sanitized,
  DROP COLUMN content_cleaned_sanitized,
  DROP COLUMN content_sanitized_version,
  DROP COLUMN full_content_original_sanitized,
  DROP COLUMN full_content_cleaned_sanitized,
  DROP COLUMN full_content_sanitized_version;

--> statement-breakpoint

-- Identical to the prior definition minus the six *_sanitized columns.
CREATE VIEW visible_entries AS
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
    s.greader_stream_id AS subscription_greader_stream_id
   FROM ((user_entries ue
     JOIN entries e ON ((e.id = ue.entry_id)))
     LEFT JOIN subscriptions s ON ((s.id = ue.subscription_id)))
  WHERE (((s.id IS NOT NULL) AND (s.unsubscribed_at IS NULL)) OR (ue.starred = true) OR (e.type = 'saved'::feed_type));
