-- The entry's own updated_at, beside the GREATEST(entry, user_entry) updated_at:
-- clients judge an entry's metadata fresh by when the entry itself last
-- changed, so a newer read/star can't make a later feed update look stale
-- (#1759). Appended, so CREATE OR REPLACE keeps the existing columns.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE VIEW visible_entries AS
 SELECT ue.user_id,
    e.id,
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
    e.unsubscribe_url,
    ue.read_changed_at,
    ue.published_or_fetched_at,
    e.greader_item_id,
    e.search_vector,
    e.updated_at AS entry_updated_at
   FROM user_entries ue
     JOIN entries e ON e.id = ue.entry_id
  WHERE ue.starred OR ue.active_memberships > 0;
