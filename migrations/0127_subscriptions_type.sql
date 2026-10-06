-- A subscription's type (web/email/saved/collection) is its own column rather
-- than something read off its feed (#1846, phase 1). A type never changes
-- after insert.
-- ADD COLUMN takes ACCESS EXCLUSIVE on a table the counter triggers update
-- constantly; fail fast rather than queue every write behind it.
SET LOCAL lock_timeout = '5s';

-- A constant default is metadata-only, so only the non-web rows get rewritten
-- (rewriting every row packs the pages full and costs the counter triggers'
-- updates their HOT path until vacuum frees space).
ALTER TABLE subscriptions ADD COLUMN type feed_type NOT NULL DEFAULT 'web';

UPDATE subscriptions s
SET type = f.type
FROM feeds f
WHERE f.id = s.feed_id AND f.type <> 'web';

-- The previous release inserts subscriptions without naming the column, so
-- fill it from the feed whenever an insert leaves it NULL (no default, below).
-- It only fills: it doesn't check an explicit type against the feed's.
CREATE FUNCTION subscriptions_fill_type() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  SELECT f.type INTO NEW.type FROM feeds f WHERE f.id = NEW.feed_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER subscriptions_fill_type_trigger
  BEFORE INSERT ON subscriptions
  FOR EACH ROW
  WHEN (NEW.type IS NULL)
  EXECUTE FUNCTION subscriptions_fill_type();

ALTER TABLE subscriptions ALTER COLUMN type DROP DEFAULT;

-- Read the type off the subscription. Same columns and values as before, so
-- the previous release reads the view unchanged.
CREATE OR REPLACE VIEW user_feeds AS
 SELECT s.id,
    s.user_id,
    s.subscribed_at,
    s.created_at,
    s.feed_id,
    s.custom_title,
    s.fetch_full_content,
    s.type,
    COALESCE(s.custom_title, f.title) AS title,
    f.title AS original_title,
    f.url,
    f.site_url,
    f.description,
    s.unread_count,
    s.greader_stream_id
   FROM subscriptions s
     JOIN feeds f ON f.id = s.feed_id
  WHERE s.unsubscribed_at IS NULL;

-- Unchanged except that collections are excluded by subscriptions.type instead
-- of a join to feeds. CREATE OR REPLACE drops the plan_cache_mode setting
-- unless the definition repeats it (#1862).
CREATE OR REPLACE FUNCTION recompute_list_counters(p_user uuid) RETURNS void
    LANGUAGE plpgsql
    SET plan_cache_mode TO 'force_custom_plan'
    AS $$
BEGIN
  PERFORM 1 FROM users WHERE id = p_user FOR NO KEY UPDATE;

  UPDATE users u
  SET uncategorized_unread_count = f.uncategorized + m.uncategorized,
      all_unread_count = f.all_active + u.saved_unread_count + f.starred_inactive + m.all_extra
  FROM (
    SELECT
      COALESCE(sum(s.unread_count) FILTER (
        WHERE s.unsubscribed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM subscription_tags st WHERE st.subscription_id = s.id)
      ), 0)::int AS uncategorized,
      COALESCE(sum(s.unread_count) FILTER (WHERE s.unsubscribed_at IS NULL), 0)::int AS all_active,
      COALESCE(sum(s.starred_unread_count) FILTER (WHERE s.unsubscribed_at IS NOT NULL), 0)::int
        AS starred_inactive
    FROM subscriptions s
    WHERE s.user_id = p_user AND s.type <> 'collection'
  ) f,
  (
    SELECT
      count(DISTINCT ue.entry_id) FILTER (
        WHERE NOT EXISTS (SELECT 1 FROM subscription_tags st WHERE st.subscription_id = ce.subscription_id)
          AND NOT (src.unsubscribed_at IS NULL AND src.id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM subscription_tags st WHERE st.subscription_id = src.id))
      )::int AS uncategorized,
      count(DISTINCT ue.entry_id) FILTER (
        WHERE ue.subscription_id IS NOT NULL AND NOT ue.starred AND src.unsubscribed_at IS NOT NULL
      )::int AS all_extra
    FROM collection_entries ce
    JOIN user_entries ue ON ue.user_id = ce.user_id AND ue.entry_id = ce.entry_id
    LEFT JOIN subscriptions src ON src.id = ue.subscription_id
    WHERE ce.user_id = p_user AND NOT ue.read AND NOT ue.is_spam
  ) m
  WHERE u.id = p_user
    AND (u.uncategorized_unread_count, u.all_unread_count)
      IS DISTINCT FROM (f.uncategorized + m.uncategorized,
                        f.all_active + u.saved_unread_count + f.starred_inactive + m.all_extra);

  UPDATE tags t
  SET unread_count = COALESCE(f.n, 0) + COALESCE(m.n, 0)
  FROM tags t2
  LEFT JOIN (
    SELECT st.tag_id, sum(s.unread_count)::int AS n
    FROM subscription_tags st
    JOIN subscriptions s ON s.id = st.subscription_id AND s.unsubscribed_at IS NULL
      AND s.type <> 'collection'
    WHERE s.user_id = p_user
    GROUP BY st.tag_id
  ) f ON f.tag_id = t2.id
  LEFT JOIN (
    SELECT st.tag_id, count(DISTINCT ue.entry_id)::int AS n
    FROM collection_entries ce
    JOIN subscription_tags st ON st.subscription_id = ce.subscription_id
    JOIN user_entries ue ON ue.user_id = ce.user_id AND ue.entry_id = ce.entry_id
    WHERE ce.user_id = p_user AND NOT ue.read AND NOT ue.is_spam
      AND NOT EXISTS (
        SELECT 1 FROM subscriptions src
        JOIN subscription_tags st2 ON st2.subscription_id = src.id AND st2.tag_id = st.tag_id
        WHERE src.id = ue.subscription_id AND src.unsubscribed_at IS NULL
      )
    GROUP BY st.tag_id
  ) m ON m.tag_id = t2.id
  WHERE t.id = t2.id AND t2.user_id = p_user
    AND t.unread_count IS DISTINCT FROM COALESCE(f.n, 0) + COALESCE(m.n, 0);
END;
$$;
