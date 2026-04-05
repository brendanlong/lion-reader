-- Backfill: subscribe all existing users to the Lion Reader announcements feed.
-- This is idempotent — if a user is already subscribed, the ON CONFLICT clause skips them.

-- First, ensure the feed exists
INSERT INTO feeds (id, type, url, title, next_fetch_at, created_at, updated_at)
VALUES (
  '019682b0-0000-7000-8000-000000000001',
  'web',
  'https://announcements.lionreader.com/feed.xml',
  'Lion Reader Announcements',
  NOW(),
  NOW(),
  NOW()
)
ON CONFLICT (url) DO NOTHING;

-- Subscribe all users who don't already have an active subscription to this feed
INSERT INTO subscriptions (id, user_id, feed_id, subscribed_at, created_at, updated_at)
SELECT
  -- Generate a deterministic UUID for each user-feed pair to make this idempotent
  gen_random_uuid(),
  u.id,
  f.id,
  NOW(),
  NOW(),
  NOW()
FROM users u
CROSS JOIN feeds f
WHERE f.url = 'https://announcements.lionreader.com/feed.xml'
  AND NOT EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.user_id = u.id
      AND s.feed_id = f.id
      AND s.unsubscribed_at IS NULL
  )
ON CONFLICT (user_id, feed_id) DO UPDATE SET
  unsubscribed_at = NULL,
  subscribed_at = NOW(),
  updated_at = NOW()
WHERE subscriptions.unsubscribed_at IS NOT NULL;

-- Backfill subscription_feeds for the new subscriptions
INSERT INTO subscription_feeds (subscription_id, feed_id, user_id)
SELECT s.id, s.feed_id, s.user_id
FROM subscriptions s
JOIN feeds f ON f.id = s.feed_id
WHERE f.url = 'https://announcements.lionreader.com/feed.xml'
  AND s.unsubscribed_at IS NULL
ON CONFLICT DO NOTHING;
