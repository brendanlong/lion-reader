-- Gives spam articles the tag and Uncategorized rows reached_tag_lists now
-- reaches (0175), so a showSpam tag list reads its own rows. As the daily
-- reconcile does live: no table locks (migrations/CLAUDE.md), and each
-- article's user_entries row held while copied, so a read committing
-- meanwhile can't miss the new row.
SET LOCAL lock_timeout = '5s';

INSERT INTO tag_entries (user_id, entry_id, list_id, published_or_fetched_at, read, starred, score)
SELECT r.user_id, r.entry_id, r.list_id, ue.published_or_fetched_at, ue.read, ue.starred, ue.score
FROM (
  SELECT DISTINCT COALESCE(t.id, se.user_id) AS list_id, se.user_id, se.entry_id
  FROM user_entries spam
  JOIN subscription_entries se ON se.user_id = spam.user_id AND se.entry_id = spam.entry_id
  JOIN subscriptions s ON s.id = se.subscription_id AND s.unsubscribed_at IS NULL
  LEFT JOIN subscription_tags st ON st.subscription_id = s.id
  LEFT JOIN tags t ON t.id = st.tag_id AND t.user_id = s.user_id AND t.deleted_at IS NULL
  WHERE spam.is_spam AND (t.id IS NOT NULL OR (st.subscription_id IS NULL AND s.type <> 'saved'))
) r
JOIN user_entries ue ON ue.user_id = r.user_id AND ue.entry_id = r.entry_id
FOR NO KEY UPDATE OF ue
ON CONFLICT DO NOTHING;
