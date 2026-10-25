-- Drops full_content_original from visible_entries before 0185 drops the
-- column (#2115). The app stopped reading it a release earlier. CREATE OR
-- REPLACE can't remove a column, so the view is rebuilt.
SET LOCAL lock_timeout = '5s';

DROP VIEW visible_entries;
--> statement-breakpoint
CREATE VIEW visible_entries AS
 SELECT ue.user_id,
    ue.entry_id AS id,
    e.owner_feed_id,
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
    ue.is_spam,
    e.list_unsubscribe_mailto,
    e.list_unsubscribe_https,
    e.list_unsubscribe_post,
    e.created_at,
    ue.changed_at AS updated_at,
    e.full_content_cleaned,
    e.full_content_fetched_at,
    e.full_content_error,
    ue.read,
    ue.starred,
    e.unsubscribe_url,
    ue.read_changed_at,
    ue.published_or_fetched_at,
    e.greader_item_id,
    e.search_vector,
    e.updated_at AS entry_updated_at,
    ue.score
   FROM (user_entries ue
     LEFT JOIN entries e ON ((e.id = ue.entry_id)))
  WHERE (ue.starred OR (ue.active_memberships > 0));
