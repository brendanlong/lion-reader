-- Drop the legacy hash-derived Wallabag id column (issue #1117, step 6c
-- release 2).
--
-- Wallabag integer ids used to be a 31-bit SHA-256 hash of the entry UUID,
-- stored in the entries.wallabag_id generated column and reverse-looked-up
-- through visible_entries. PR #1225 (previous release) switched the Wallabag
-- API to the stored serials (entries.greader_item_id etc.) and removed every
-- read of wallabag_id and its Drizzle definitions, so the view can now be
-- rebuilt without the column and the column (and its index, which drops with
-- it) removed. Also stops every entry insert paying a sha256() for a value
-- nothing reads.
--
-- Expand/contract: safe for the previous release (#1225) — it selects explicit
-- column lists everywhere (never SELECT *) and no longer references
-- wallabag_id in code or in its Drizzle definitions of entries and
-- visible_entries. Must not deploy before #1225 has: the release before that
-- still resolves Wallabag ids via visible_entries.wallabag_id.

DROP VIEW visible_entries;

--> statement-breakpoint

ALTER TABLE entries DROP COLUMN wallabag_id;

--> statement-breakpoint

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
    e.content_original_sanitized,
    e.content_cleaned_sanitized,
    e.content_sanitized_version,
    e.full_content_original_sanitized,
    e.full_content_cleaned_sanitized,
    e.full_content_sanitized_version,
    e.greader_item_id,
    s.greader_stream_id AS subscription_greader_stream_id
   FROM ((user_entries ue
     JOIN entries e ON ((e.id = ue.entry_id)))
     LEFT JOIN subscriptions s ON ((s.id = ue.subscription_id)))
  WHERE (((s.id IS NOT NULL) AND (s.unsubscribed_at IS NULL)) OR (ue.starred = true) OR (e.type = 'saved'::feed_type));
