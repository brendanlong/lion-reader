-- Drop the vestigial entry-scoring columns (issue #1101, release 2).
--
-- The ML entry-scoring feature was removed in migration 0073 (#953), but the
-- per-user-entry columns (score, score_changed_at, has_marked_read_on_list,
-- has_marked_unread, has_starred) were left behind, and visible_entries kept
-- selecting four of them. The previous release (#1135) removed every read and
-- write of these columns, so the view can now be rebuilt without them and the
-- columns dropped.
--
-- Expand/contract: safe for the previous release. It selects explicit column
-- lists everywhere (never SELECT *) and no longer references any of these
-- columns in code or in its Drizzle definitions of user_entries and
-- visible_entries.
--
-- Dropping the score column also drops the user_entries_score_range CHECK
-- constraint that depended on it.

DROP VIEW visible_entries;

--> statement-breakpoint

ALTER TABLE user_entries
  DROP COLUMN score,
  DROP COLUMN score_changed_at,
  DROP COLUMN has_marked_read_on_list,
  DROP COLUMN has_marked_unread,
  DROP COLUMN has_starred;

--> statement-breakpoint

-- Identical to the 0087 definition minus the scoring columns.
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
    e.wallabag_id,
    ue.published_or_fetched_at,
    e.content_original_sanitized,
    e.content_cleaned_sanitized,
    e.content_sanitized_version,
    e.full_content_original_sanitized,
    e.full_content_cleaned_sanitized,
    e.full_content_sanitized_version
   FROM ((user_entries ue
     JOIN entries e ON ((e.id = ue.entry_id)))
     LEFT JOIN subscriptions s ON ((s.id = ue.subscription_id)))
  WHERE (((s.id IS NOT NULL) AND (s.unsubscribed_at IS NULL)) OR (ue.starred = true) OR (e.type = 'saved'::feed_type));
