-- Migration: Add full_content_hash column to entries
-- Stores a separate content hash for full content (fetched from URL),
-- enabling separate summary caching for feed content vs full content.

ALTER TABLE entries
ADD COLUMN full_content_hash text;

-- Update visible_entries view to expose the new column
DROP VIEW IF EXISTS visible_entries;

CREATE VIEW visible_entries AS
SELECT
  ue.user_id,
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
  e.updated_at,
  e.full_content_original,
  e.full_content_cleaned,
  e.full_content_fetched_at,
  e.full_content_error,
  ue.read,
  ue.starred,
  s.id AS subscription_id
FROM user_entries ue
JOIN entries e ON e.id = ue.entry_id
LEFT JOIN subscriptions s ON (
  s.user_id = ue.user_id
  AND e.feed_id = ANY(s.feed_ids)
)
WHERE
  s.unsubscribed_at IS NULL
  OR ue.starred = true;
