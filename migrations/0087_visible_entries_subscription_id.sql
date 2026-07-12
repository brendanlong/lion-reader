-- Flip entry visibility onto user_entries.subscription_id (issue #1117, step 4).
--
-- visible_entries previously resolved the entry→subscription link through the
-- subscription_feeds junction (one row per matching junction row, so an entry
-- reachable through overlapping subscriptions appeared multiple times and every
-- consumer had to dedupe with COUNT(DISTINCT) / DISTINCT ON). The stamped
-- user_entries.subscription_id column (migration 0086) was reconciled against
-- the junction-derived attribution in production (zero mismatches, 2026-07-11),
-- so the view can now join subscriptions directly:
--
--   - one row per user_entries row, no duplicates, no dedup needed
--   - the visibility predicate is unchanged and stays fail-closed:
--     active subscription OR starred OR saved article. The saved arm gates on
--     the entry TYPE, never "subscription_id IS NULL", so a NULL-attributed
--     row (e.g. after an ON DELETE SET NULL) is hidden unless starred.
--
-- Expand/contract: safe for the previous release. Old code reads the same
-- columns with the same meaning — it just no longer sees duplicate rows, which
-- its COUNT(DISTINCT)/DISTINCT ON handling treats identically. Old code also
-- still dual-writes both subscription_id and subscription_feeds.
--
-- subscription_feeds is now WRITE-ONLY from the view's perspective; the
-- remaining direct readers (fanout GUID dedup, Google Reader newest-item) and
-- the junction writes/table are removed in a later release once no running
-- release reads it.

DROP VIEW visible_entries;

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
    ue.score,
    ue.has_marked_read_on_list,
    ue.has_marked_unread,
    ue.has_starred,
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
