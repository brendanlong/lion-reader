-- Auto-subscribe all existing users to the Lion Reader announcements feed.
-- Only subscribes users who don't already have an active subscription to this feed.

-- First, ensure the feed exists
INSERT INTO feeds (id, type, url, title, next_fetch_at, created_at, updated_at)
SELECT
  gen_random_uuid(),
  'web',
  'https://announcements.lionreader.com/feed.xml',
  'Lion Reader Announcements',
  NOW(),
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM feeds WHERE url = 'https://announcements.lionreader.com/feed.xml'
);
--> statement-breakpoint

-- Subscribe all users who aren't already subscribed (or reactivate soft-deleted subscriptions)
-- First, reactivate any soft-deleted subscriptions
UPDATE subscriptions
SET unsubscribed_at = NULL, subscribed_at = NOW(), updated_at = NOW()
WHERE feed_id = (SELECT id FROM feeds WHERE url = 'https://announcements.lionreader.com/feed.xml')
  AND unsubscribed_at IS NOT NULL;
--> statement-breakpoint

-- Then create new subscriptions for users who have never subscribed
INSERT INTO subscriptions (id, user_id, feed_id, subscribed_at, created_at, updated_at)
SELECT
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
  );
--> statement-breakpoint

-- Populate subscription_feeds junction table for all active subscriptions
INSERT INTO subscription_feeds (subscription_id, feed_id, user_id)
SELECT s.id, s.feed_id, s.user_id
FROM subscriptions s
JOIN feeds f ON f.id = s.feed_id
WHERE f.url = 'https://announcements.lionreader.com/feed.xml'
  AND s.unsubscribed_at IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Ensure a fetch job exists for the feed
INSERT INTO jobs (id, type, payload, next_run_at, created_at, updated_at)
SELECT
  gen_random_uuid(),
  'fetch_feed',
  jsonb_build_object('feedId', f.id),
  NOW(),
  NOW(),
  NOW()
FROM feeds f
WHERE f.url = 'https://announcements.lionreader.com/feed.xml'
  AND NOT EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.type = 'fetch_feed'
      AND j.payload->>'feedId' = f.id::text
  );
