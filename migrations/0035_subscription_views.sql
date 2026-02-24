-- Migration: Add database views for subscription-centric API
-- These views simplify queries by abstracting the feeds/subscriptions join

-- user_feeds: Active subscriptions with feed metadata merged
-- Uses subscription.id as the primary key
CREATE VIEW user_feeds AS
SELECT
  s.id,
  s.user_id,
  s.subscribed_at,
  s.feed_id,                                      -- internal use only
  s.feed_ids,                                     -- for entry visibility queries
  s.custom_title,
  f.type,
  COALESCE(s.custom_title, f.title) AS title,    -- resolved title
  f.title AS original_title,                      -- for "rename" UI
  f.url,
  f.site_url,
  f.description
FROM subscriptions s
JOIN feeds f ON f.id = s.feed_id
WHERE s.unsubscribed_at IS NULL;

-- visible_entries: Entries with visibility rules and subscription context
-- An entry is visible if:
-- 1. User has a user_entries row for it, AND
-- 2. Either the entry is from an active subscription, OR the entry is starred
--
-- The LEFT JOIN finds any matching subscription (active or not), then WHERE
-- determines visibility. This keeps subscription_id for starred entries even
-- after unsubscribing (useful for cache handling if user resubscribes).
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
