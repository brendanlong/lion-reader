-- A collection's name lives on its subscription, and active collections'
-- names are unique per user ignoring case (#1846, phase 2A). Production has no
-- collections whose names differ only in case (checked).
-- The index build takes a SHARE lock on a table the counter triggers update
-- constantly; fail fast rather than queue every write behind it.
SET LOCAL lock_timeout = '5s';

-- Copy the displayed name (COALESCE(custom_title, feeds.title)) of every
-- collection, active or not, so a deleted collection keeps its name. The name
-- doesn't change, so updated_at doesn't move (no delta-sync churn).
UPDATE subscriptions s
SET custom_title = f.title
FROM feeds f
WHERE f.id = s.feed_id AND s.type = 'collection' AND s.custom_title IS NULL;

-- Collections the previous release creates during the rollout have a NULL
-- custom_title, which the index ignores, so its inserts never fail.
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_user_collection_name
  ON subscriptions (user_id, lower(custom_title))
  WHERE type = 'collection' AND unsubscribed_at IS NULL;
