-- Gives spam articles the tag and Uncategorized rows reached_tag_lists now
-- reaches (0174), so a showSpam tag list reads its own rows. Everything the
-- rows derive from is locked up front in the lock order (migration 0167 says
-- why); spam is rare, so writes wait only for one scan of user_entries.
SET LOCAL lock_timeout = '5s';

LOCK TABLE user_entries, subscription_entries, subscriptions, subscription_tags, tags
  IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO tag_entries (user_id, entry_id, list_id, published_or_fetched_at, read, starred, score)
SELECT DISTINCT ue.user_id, ue.entry_id, COALESCE(t.id, se.user_id),
       ue.published_or_fetched_at, ue.read, ue.starred, ue.score
FROM user_entries ue
JOIN subscription_entries se ON se.user_id = ue.user_id AND se.entry_id = ue.entry_id
JOIN subscriptions s ON s.id = se.subscription_id AND s.unsubscribed_at IS NULL
LEFT JOIN subscription_tags st ON st.subscription_id = s.id
LEFT JOIN tags t ON t.id = st.tag_id AND t.user_id = s.user_id AND t.deleted_at IS NULL
WHERE ue.is_spam AND (t.id IS NOT NULL OR (st.subscription_id IS NULL AND s.type <> 'saved'))
ON CONFLICT DO NOTHING;
