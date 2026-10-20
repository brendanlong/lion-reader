-- Tag and Uncategorized lists get rows of their own (#2066): one per
-- (list, entry), where the list is a tag or, for Uncategorized, the user. A
-- non-spam entry has a tag's row while an active subscription with that tag
-- holds it, and Uncategorized's while an untagged one other than saved does.
-- Rows carry the user_entries row's read and starred like memberships do
-- (migration 0165), so a tag page reads an index of the tag's own rows instead
-- of walking the user's timeline. Spam (never in a default list) has no rows,
-- so a showSpam tag list filters the timeline as before. Triggers keep the
-- rows; app code never writes them.
SET LOCAL lock_timeout = '5s';

-- Everything the rows derive from, up front and in the lock order
-- (src/server/CLAUDE.md): writes wait until the backfill below is done, and
-- one already holding a lock can't deadlock with the migration.
LOCK TABLE user_entries, subscription_entries, subscriptions, subscription_tags, tags
  IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- A list id implies its user, so the key leading with (user_id, entry_id) is
-- as unique as (list_id, entry_id), and also serves every lookup by article.
CREATE TABLE tag_entries (
  user_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  list_id uuid NOT NULL,
  published_or_fetched_at timestamptz NOT NULL,
  read boolean NOT NULL,
  starred boolean NOT NULL,
  PRIMARY KEY (user_id, entry_id, list_id),
  FOREIGN KEY (user_id, entry_id) REFERENCES user_entries (user_id, entry_id)
    ON DELETE CASCADE ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE INDEX idx_tag_entries_timeline
  ON tag_entries (list_id, published_or_fetched_at DESC, entry_id DESC);
--> statement-breakpoint
CREATE INDEX idx_tag_entries_unread_timeline
  ON tag_entries (list_id, published_or_fetched_at DESC, entry_id DESC) WHERE NOT read;
--> statement-breakpoint
-- The lists each of these (user, entry) pairs should be in.
CREATE FUNCTION reached_tag_lists(p_user uuid[], p_entry uuid[])
    RETURNS TABLE (list_id uuid, user_id uuid, entry_id uuid)
    LANGUAGE sql STABLE
    AS $$
  SELECT DISTINCT COALESCE(t.id, se.user_id), se.user_id, se.entry_id
  FROM (SELECT DISTINCT u, e FROM unnest(p_user, p_entry) AS p(u, e)) p
  JOIN subscription_entries se ON se.user_id = p.u AND se.entry_id = p.e AND NOT se.is_spam
  JOIN subscriptions s ON s.id = se.subscription_id AND s.unsubscribed_at IS NULL
  LEFT JOIN subscription_tags st ON st.subscription_id = s.id
  LEFT JOIN tags t ON t.id = st.tag_id AND t.user_id = s.user_id AND t.deleted_at IS NULL
  WHERE t.id IS NOT NULL OR (st.subscription_id IS NULL AND s.type <> 'saved')
$$;
--> statement-breakpoint
-- Removes the pairs' rows their memberships no longer reach.
--
-- These functions are planned per call (plan_cache_mode): a generic plan
-- guesses ten pairs and runs for minutes on a large retag.
CREATE FUNCTION drop_unreached_tag_entries(p_user uuid[], p_entry uuid[]) RETURNS void
    LANGUAGE plpgsql
    SET plan_cache_mode TO 'force_custom_plan'
    AS $$
BEGIN
  IF p_user IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM tag_entries te
  USING (SELECT DISTINCT u, e FROM unnest(p_user, p_entry) AS p(u, e)) p
  WHERE te.user_id = p.u AND te.entry_id = p.e
    AND NOT EXISTS (
      SELECT 1 FROM reached_tag_lists(p_user, p_entry) r
      WHERE r.user_id = te.user_id AND r.entry_id = te.entry_id AND r.list_id = te.list_id
    );
END;
$$;
--> statement-breakpoint
-- Adds the rows the pairs' memberships reach. A new row copies its
-- user_entries row's state, so this locks those rows first (in key order),
-- unless the caller already holds them (`p_locked`): a read or star committing
-- meanwhile would otherwise miss the new row.
CREATE FUNCTION add_reached_tag_entries(p_user uuid[], p_entry uuid[], p_locked boolean)
    RETURNS void
    LANGUAGE plpgsql
    SET plan_cache_mode TO 'force_custom_plan'
    AS $$
BEGIN
  IF p_user IS NULL THEN
    RETURN;
  END IF;

  IF NOT p_locked THEN
    PERFORM 1
    FROM user_entries ue
    JOIN (
      SELECT DISTINCT r.user_id, r.entry_id
      FROM reached_tag_lists(p_user, p_entry) r
      WHERE NOT EXISTS (
        SELECT 1 FROM tag_entries te
        WHERE te.user_id = r.user_id AND te.entry_id = r.entry_id AND te.list_id = r.list_id
      )
    ) m ON m.user_id = ue.user_id AND m.entry_id = ue.entry_id
    ORDER BY ue.user_id, ue.entry_id
    FOR NO KEY UPDATE OF ue;
  END IF;

  INSERT INTO tag_entries (user_id, entry_id, list_id, published_or_fetched_at, read, starred)
  SELECT r.user_id, r.entry_id, r.list_id, ue.published_or_fetched_at, ue.read, ue.starred
  FROM reached_tag_lists(p_user, p_entry) r
  JOIN user_entries ue ON ue.user_id = r.user_id AND ue.entry_id = r.entry_id
  ORDER BY r.user_id, r.entry_id, r.list_id
  ON CONFLICT DO NOTHING;
END;
$$;
--> statement-breakpoint
-- The (user, entry) pairs of these subscriptions' memberships.
CREATE FUNCTION subscription_members(p_sub uuid[], OUT o_user uuid[], OUT o_entry uuid[])
    LANGUAGE sql STABLE
    AS $$
  SELECT array_agg(se.user_id), array_agg(se.entry_id)
  FROM subscription_entries se
  WHERE se.subscription_id = ANY(p_sub)
$$;
--> statement-breakpoint
-- A new membership only adds lists, and the copy above already holds its rows.
CREATE OR REPLACE FUNCTION subscription_entries_copy_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_user uuid[]; v_entry uuid[];
BEGIN
  EXECUTE $q$
    SELECT 1
    FROM user_entries ue
    JOIN (SELECT DISTINCT user_id, entry_id FROM changed_rows) c
      ON c.user_id = ue.user_id AND c.entry_id = ue.entry_id
    ORDER BY ue.user_id, ue.entry_id
    FOR NO KEY UPDATE OF ue
  $q$;

  EXECUTE $q$
    UPDATE subscription_entries se
    SET read = ue.read, starred = ue.starred, is_spam = ue.is_spam
    FROM changed_rows c
    JOIN user_entries ue ON ue.user_id = c.user_id AND ue.entry_id = c.entry_id
    WHERE se.subscription_id = c.subscription_id AND se.entry_id = c.entry_id
      AND (se.read, se.starred, se.is_spam) IS DISTINCT FROM (ue.read, ue.starred, ue.is_spam)
  $q$;

  -- The subscriptions next, as the counter trigger after this one does, so
  -- whether they're active and how they're tagged can't change before this
  -- commits: an unsubscribe or retag running meanwhile waits, then sees the
  -- new memberships.
  EXECUTE $q$
    SELECT 1 FROM subscriptions
    WHERE id IN (SELECT DISTINCT subscription_id FROM changed_rows)
    ORDER BY id FOR NO KEY UPDATE
  $q$;

  SELECT array_agg(user_id), array_agg(entry_id) INTO v_user, v_entry FROM changed_rows;
  PERFORM add_reached_tag_entries(v_user, v_entry, true);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- Removing memberships only removes lists.
CREATE FUNCTION subscription_entries_drop_lists() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_user uuid[]; v_entry uuid[];
BEGIN
  SELECT array_agg(user_id), array_agg(entry_id) INTO v_user, v_entry FROM changed_rows;
  PERFORM drop_unreached_tag_entries(v_user, v_entry);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER subscription_entries_drop_lists_trigger
  AFTER DELETE ON subscription_entries
  REFERENCING OLD TABLE AS changed_rows
  FOR EACH STATEMENT EXECUTE FUNCTION subscription_entries_drop_lists();
--> statement-breakpoint
-- (Un)subscribing and retagging change what a subscription's members reach.
-- Those paths lock the members' user_entries rows and then the subscription
-- rows first, so the existing list-recompute triggers move the members' tag
-- rows too. A tag change can both add a list and drop one (Uncategorized,
-- when the first tag comes or the last goes).
CREATE OR REPLACE FUNCTION subscription_tags_recompute_lists() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_user uuid[]; v_entry uuid[];
BEGIN
  SELECT o_user, o_entry INTO v_user, v_entry
  FROM subscription_members(ARRAY(SELECT DISTINCT subscription_id FROM changed_rows));
  PERFORM drop_unreached_tag_entries(v_user, v_entry);
  PERFORM add_reached_tag_entries(v_user, v_entry, false);
  PERFORM recompute_list_counters(u.user_id)
  FROM (
    SELECT DISTINCT s.user_id FROM changed_rows c JOIN subscriptions s ON s.id = c.subscription_id
    ORDER BY s.user_id
  ) u;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subscriptions_recompute_lists() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  a_id uuid[]; a_user uuid[]; a_d integer[];
  v_user uuid[]; v_entry uuid[];
BEGIN
  SELECT array_agg(id), array_agg(user_id), array_agg(d) INTO a_id, a_user, a_d
  FROM (
    SELECT id, user_id, sum(d)::int AS d
    FROM (
      SELECT id, user_id, CASE WHEN unsubscribed_at IS NULL THEN 1 ELSE 0 END AS d FROM changed_rows
      UNION ALL
      SELECT id, user_id, CASE WHEN unsubscribed_at IS NULL THEN -1 ELSE 0 END FROM old_rows
    ) x
    GROUP BY id, user_id
    HAVING sum(d) <> 0
  ) a;
  IF a_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Unsubscribing only drops lists, and resubscribing only adds them.
  SELECT o_user, o_entry INTO v_user, v_entry
  FROM subscription_members(ARRAY(SELECT id FROM unnest(a_id, a_d) AS a(id, d) WHERE d < 0));
  PERFORM drop_unreached_tag_entries(v_user, v_entry);
  SELECT o_user, o_entry INTO v_user, v_entry
  FROM subscription_members(ARRAY(SELECT id FROM unnest(a_id, a_d) AS a(id, d) WHERE d > 0));
  PERFORM add_reached_tag_entries(v_user, v_entry, false);

  UPDATE user_entries ue
  SET active_memberships = ue.active_memberships + m.d
  FROM (
    SELECT se.user_id, se.entry_id, sum(a.d)::int AS d
    FROM unnest(a_id, a_d) AS a(id, d)
    JOIN subscription_entries se ON se.subscription_id = a.id
    GROUP BY se.user_id, se.entry_id
  ) m
  WHERE ue.user_id = m.user_id AND ue.entry_id = m.entry_id AND m.d <> 0;

  PERFORM recompute_list_counters(u.user_id)
  FROM (SELECT DISTINCT user_id FROM unnest(a_user) AS a(user_id) ORDER BY user_id) u;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION user_entries_copy_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  EXECUTE $q$
    UPDATE subscription_entries se
    SET read = n.read, starred = n.starred, is_spam = n.is_spam
    FROM (
      SELECT user_id, entry_id, read, starred, is_spam FROM new_rows
      EXCEPT
      SELECT user_id, entry_id, read, starred, is_spam FROM old_rows
    ) n
    WHERE se.user_id = n.user_id AND se.entry_id = n.entry_id
      AND (se.read, se.starred, se.is_spam) IS DISTINCT FROM (n.read, n.starred, n.is_spam)
  $q$;

  EXECUTE $q$
    UPDATE tag_entries te
    SET read = n.read, starred = n.starred
    FROM (
      SELECT user_id, entry_id, read, starred FROM new_rows
      EXCEPT
      SELECT user_id, entry_id, read, starred FROM old_rows
    ) n
    WHERE te.user_id = n.user_id AND te.entry_id = n.entry_id
      AND (te.read, te.starred) IS DISTINCT FROM (n.read, n.starred)
  $q$;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- A tag's tombstone hides its list. deleteTag removes the tag's subscriptions
-- first (locking their members), so this normally has nothing to drop.
CREATE FUNCTION tags_drop_lists() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_user uuid[]; v_entry uuid[];
BEGIN
  SELECT o_user, o_entry INTO v_user, v_entry
  FROM subscription_members(ARRAY(SELECT subscription_id FROM subscription_tags WHERE tag_id = NEW.id));
  PERFORM drop_unreached_tag_entries(v_user, v_entry);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tags_drop_lists_trigger
  AFTER UPDATE OF deleted_at ON tags
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION tags_drop_lists();
--> statement-breakpoint
INSERT INTO tag_entries (user_id, entry_id, list_id, published_or_fetched_at, read, starred)
SELECT DISTINCT ON (r.user_id, r.entry_id, r.list_id)
       r.user_id, r.entry_id, r.list_id, ue.published_or_fetched_at, ue.read, ue.starred
FROM (
  SELECT COALESCE(t.id, se.user_id) AS list_id, se.user_id, se.entry_id
  FROM subscription_entries se
  JOIN subscriptions s ON s.id = se.subscription_id AND s.unsubscribed_at IS NULL
  LEFT JOIN subscription_tags st ON st.subscription_id = s.id
  LEFT JOIN tags t ON t.id = st.tag_id AND t.user_id = s.user_id AND t.deleted_at IS NULL
  WHERE NOT se.is_spam
    AND (t.id IS NOT NULL OR (st.subscription_id IS NULL AND s.type <> 'saved'))
) r
JOIN user_entries ue ON ue.user_id = r.user_id AND ue.entry_id = r.entry_id;
