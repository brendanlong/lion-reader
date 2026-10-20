-- Fills migration 0165's copies for memberships that existed before its
-- triggers. A share lock on user_entries holds every row's state still while
-- this runs (writes wait; reads don't), and the triggers keep up from here.
SET LOCAL lock_timeout = '5s';

LOCK TABLE user_entries IN SHARE MODE;
--> statement-breakpoint
UPDATE subscription_entries se
SET read = ue.read, starred = ue.starred, is_spam = ue.is_spam
FROM user_entries ue
WHERE ue.user_id = se.user_id AND ue.entry_id = se.entry_id
  AND (se.read, se.starred, se.is_spam) IS DISTINCT FROM (ue.read, ue.starred, ue.is_spam);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscription_entries_unread_timeline
  ON subscription_entries (subscription_id, published_or_fetched_at DESC, entry_id DESC)
  WHERE NOT read AND NOT is_spam;
