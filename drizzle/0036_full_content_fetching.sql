-- Migration: Add full content fetching support
-- Adds fields to entries for storing fetched full content
-- Adds field to subscriptions for enabling full content fetching per-feed

-- Add full content fields to entries table
ALTER TABLE entries
ADD COLUMN full_content_original text,
ADD COLUMN full_content_cleaned text,
ADD COLUMN full_content_fetched_at timestamptz,
ADD COLUMN full_content_error text;

-- Add fetch_full_content preference to subscriptions
ALTER TABLE subscriptions
ADD COLUMN fetch_full_content boolean NOT NULL DEFAULT false;

-- Update user_feeds view to include fetch_full_content
DROP VIEW IF EXISTS user_feeds CASCADE;

CREATE VIEW user_feeds AS
SELECT
  s.id,
  s.user_id,
  s.subscribed_at,
  s.feed_id,                                      -- internal use only
  s.feed_ids,                                     -- for entry visibility queries
  s.custom_title,
  s.fetch_full_content,
  f.type,
  COALESCE(s.custom_title, f.title) AS title,    -- resolved title
  f.title AS original_title,                      -- for "rename" UI
  f.url,
  f.site_url,
  f.description
FROM subscriptions s
JOIN feeds f ON f.id = s.feed_id
WHERE s.unsubscribed_at IS NULL;

-- Recreate visible_entries view (depends on user_feeds, and needs full content fields)
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
