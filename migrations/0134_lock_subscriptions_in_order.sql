-- Lock the subscriptions a counter change updates in id order, as
-- src/server/CLAUDE.md requires (#1846; CI run 37675879817 deadlocked two
-- mark-reads of articles in the same feed and collection).
CREATE OR REPLACE FUNCTION apply_unread_memberships(
  p_sign integer[], p_user uuid[], p_entry uuid[], p_sub uuid[], p_complete boolean,
  p_count_user uuid[] DEFAULT NULL, p_all integer[] DEFAULT NULL, p_starred integer[] DEFAULT NULL
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  l_user uuid[]; l_tag uuid[]; l_n integer[];
BEGIN
  IF p_sign IS NULL AND p_count_user IS NULL THEN
    RETURN;
  END IF;

  -- Sorted, before updating them: the UPDATE below locks rows in whatever
  -- order its plan meets them, so two mark-reads of articles in the same two
  -- subscriptions could lock them in opposite orders and deadlock.
  PERFORM 1 FROM subscriptions
  WHERE id IN (SELECT unnest(p_sub))
  ORDER BY id FOR NO KEY UPDATE;

  UPDATE subscriptions s
  SET unread_count = s.unread_count + d.n
  FROM (
    SELECT subscription_id, sum(sign)::int AS n
    FROM unnest(p_sign, p_sub) AS c(sign, subscription_id)
    GROUP BY subscription_id
    HAVING sum(sign) <> 0
  ) d
  WHERE s.id = d.subscription_id;

  -- Before reading tags: a concurrent tag change that recomputes the user's
  -- lists holds this lock, and the statements below then see it committed.
  PERFORM 1 FROM users
  WHERE id IN (SELECT unnest(p_user) UNION SELECT unnest(p_count_user))
  ORDER BY id FOR NO KEY UPDATE;

  -- What each changed membership reaches: its active subscription's tags, or
  -- Uncategorized (tag_id NULL) for an untagged one other than saved.
  WITH changed AS (
    SELECT c.user_id, c.entry_id, st.tag_id, c.sign
    FROM unnest(p_sign, p_user, p_entry, p_sub) AS c(sign, user_id, entry_id, subscription_id)
    JOIN subscriptions s ON s.id = c.subscription_id AND s.unsubscribed_at IS NULL
    LEFT JOIN subscription_tags st ON st.subscription_id = s.id
    WHERE st.tag_id IS NOT NULL OR s.type <> 'saved'
  ),
  reached AS (
    SELECT user_id, entry_id, tag_id FROM changed WHERE p_complete AND sign > 0
    UNION ALL
    SELECT p.user_id, p.entry_id, st.tag_id
    FROM (SELECT DISTINCT user_id, entry_id FROM changed WHERE NOT p_complete) p
    JOIN user_entries ue ON ue.user_id = p.user_id AND ue.entry_id = p.entry_id
      AND NOT ue.read AND NOT ue.is_spam
    JOIN subscription_entries se ON se.user_id = p.user_id AND se.entry_id = p.entry_id
    JOIN subscriptions s ON s.id = se.subscription_id AND s.unsubscribed_at IS NULL
    LEFT JOIN subscription_tags st ON st.subscription_id = s.id
    WHERE st.tag_id IS NOT NULL OR s.type <> 'saved'
  ),
  per_article AS (
    SELECT user_id, tag_id, sum(now)::int AS now, sum(now - change)::int AS before
    FROM (
      SELECT user_id, entry_id, tag_id, 1 AS now, 0 AS change FROM reached
      UNION ALL
      SELECT user_id, entry_id, tag_id, 0, sign FROM changed
    ) x
    GROUP BY user_id, entry_id, tag_id
  ),
  d AS (
    SELECT user_id, tag_id, sum((now > 0)::int - (before > 0)::int)::int AS n
    FROM per_article
    GROUP BY user_id, tag_id
    HAVING sum((now > 0)::int - (before > 0)::int) <> 0
  )
  SELECT array_agg(user_id), array_agg(tag_id), array_agg(n) INTO l_user, l_tag, l_n FROM d;

  UPDATE users u
  SET uncategorized_unread_count = u.uncategorized_unread_count + d.uc,
      saved_unread_count = u.saved_unread_count + d.sv,
      all_unread_count = u.all_unread_count + d.al,
      starred_unread_count = u.starred_unread_count + d.st
  FROM (
    SELECT user_id, sum(uc)::int AS uc, sum(sv)::int AS sv, sum(al)::int AS al, sum(st)::int AS st
    FROM (
      SELECT l.user_id, l.n AS uc, 0 AS sv, 0 AS al, 0 AS st
      FROM unnest(l_user, l_tag, l_n) AS l(user_id, tag_id, n)
      WHERE l.tag_id IS NULL
      UNION ALL
      SELECT c.user_id, 0, c.sign, 0, 0
      FROM unnest(p_sign, p_user, p_sub) AS c(sign, user_id, subscription_id)
      JOIN subscriptions s ON s.id = c.subscription_id AND s.type = 'saved'
      UNION ALL
      SELECT r.user_id, 0, 0, r.al, r.st
      FROM unnest(p_count_user, p_all, p_starred) AS r(user_id, al, st)
    ) x
    GROUP BY user_id
    HAVING sum(uc) <> 0 OR sum(sv) <> 0 OR sum(al) <> 0 OR sum(st) <> 0
  ) d
  WHERE u.id = d.user_id;

  UPDATE tags t
  SET unread_count = t.unread_count + d.n
  FROM (
    SELECT l.tag_id, sum(l.n)::int AS n
    FROM unnest(l_tag, l_n) AS l(tag_id, n)
    WHERE l.tag_id IS NOT NULL
    GROUP BY l.tag_id
  ) d
  WHERE t.id = d.tag_id AND d.n <> 0;
END;
$$;
