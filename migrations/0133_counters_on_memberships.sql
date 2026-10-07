-- Counters and visibility read memberships (#1846, phase 5A).
--
-- Every rule is stated once, over subscription_entries:
--   visible       = starred, or in at least one active subscription
--                   (user_entries.active_memberships > 0);
--   subscription  = its unread, non-spam memberships, active or not, saved
--                   included (users.saved_unread_count, which the previous
--                   release reads, is the saved subscription's);
--   All           = visible, unread, non-spam articles;
--   tag           = distinct unread, non-spam articles in an active
--                   subscription with that tag;
--   Uncategorized = the same for untagged subscriptions other than saved.
-- subscriptions.starred_unread_count is no longer maintained (nothing reads
-- it); it's dropped with users.saved_unread_count in phase 5B.
--
-- The previous release reads only visible_entries, the counters and the old
-- membership forms, which the mirror triggers still keep, so it works
-- unchanged: for every article it can reach, the new rules give the same
-- answers as the old ones.
--
-- Locks: adding the column takes ACCESS EXCLUSIVE on user_entries, so reads
-- of it wait for this migration. Take every lock up front in the counter
-- triggers' order (user_entries, subscription_entries, subscriptions).
SET LOCAL lock_timeout = '5s';
LOCK TABLE user_entries IN ACCESS EXCLUSIVE MODE;
LOCK TABLE collection_entries, subscription_entries IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE subscriptions IN SHARE ROW EXCLUSIVE MODE;

-- The previous release's daily reconcile_counters job recomputes the counters
-- by its own rules, which differ for the saved subscription and merged-away
-- ones. Keep it from running while that release is still up.
UPDATE jobs SET next_run_at = GREATEST(next_run_at, now() + interval '2 hours')
WHERE type = 'reconcile_counters';

-- The old counter triggers, replaced below.
DROP TRIGGER user_entries_counters_insert_trigger ON user_entries;
DROP TRIGGER user_entries_counters_update_trigger ON user_entries;
DROP TRIGGER user_entries_counters_delete_trigger ON user_entries;
DROP TRIGGER collection_entries_counters_insert_trigger ON collection_entries;
DROP TRIGGER collection_entries_counters_delete_trigger ON collection_entries;
DROP TRIGGER collection_entries_recompute_lists_insert_trigger ON collection_entries;
DROP TRIGGER collection_entries_recompute_lists_delete_trigger ON collection_entries;
DROP FUNCTION user_entries_counters_insert();
DROP FUNCTION user_entries_counters_update();
DROP FUNCTION user_entries_counters_delete();
DROP FUNCTION collection_entries_counters_insert();
DROP FUNCTION collection_entries_counters_delete();
DROP FUNCTION collection_entries_recompute_lists();
DROP FUNCTION apply_unread_rows(integer[], uuid[], uuid[], uuid[], boolean[], boolean);

-- How many active subscriptions hold the article, so visibility and All need
-- only the row. Almost every article is in exactly one, so the column starts
-- at 1 (a default fills existing rows without rewriting them) and only the
-- others are written; new rows get theirs from the fill trigger.
ALTER TABLE user_entries ADD COLUMN active_memberships integer NOT NULL DEFAULT 1;
UPDATE user_entries ue
SET active_memberships = c.n
FROM (
  SELECT ue2.user_id, ue2.entry_id, count(s.id)::int AS n
  FROM user_entries ue2
  LEFT JOIN subscription_entries se ON se.user_id = ue2.user_id AND se.entry_id = ue2.entry_id
  LEFT JOIN subscriptions s ON s.id = se.subscription_id AND s.unsubscribed_at IS NULL
  GROUP BY ue2.user_id, ue2.entry_id
) c
WHERE ue.user_id = c.user_id AND ue.entry_id = c.entry_id AND c.n <> 1;
ALTER TABLE user_entries ALTER COLUMN active_memberships SET DEFAULT 0;
ALTER TABLE user_entries
  ADD CONSTRAINT user_entries_active_memberships_nonnegative CHECK (active_memberships >= 0);
-- The articles a sum over subscriptions could count twice (recompute_list_counters).
CREATE INDEX idx_user_entries_multi_member ON user_entries (user_id) WHERE active_memberships > 1;

-- The user_entries delete trigger counts a deleted article's memberships before
-- removing them itself, so they must outlive the row until then: the foreign
-- key no longer cascades deletes, and is checked at commit.
ALTER TABLE subscription_entries DROP CONSTRAINT subscription_entries_user_id_entry_id_fkey;
ALTER TABLE subscription_entries
  ADD CONSTRAINT subscription_entries_user_id_entry_id_fkey
  FOREIGN KEY (user_id, entry_id) REFERENCES user_entries (user_id, entry_id)
  ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE subscription_entries VALIDATE CONSTRAINT subscription_entries_user_id_entry_id_fkey;

-- A new row's active_memberships counts its source subscription if active, or
-- for a saved article the saved subscription the mirror adds it to. The
-- subscription_entries insert trigger recomputes it from the memberships, so
-- this only spares that trigger an update of every new row.
CREATE OR REPLACE FUNCTION user_entries_fill_denormalized() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_feed_id uuid;
  v_type feed_type;
BEGIN
  IF NEW.published_or_fetched_at IS NULL
     OR NEW.is_spam IS NULL
     OR NEW.subscription_id IS NULL THEN
    SELECT COALESCE(NEW.published_or_fetched_at, e.published_at, e.fetched_at),
           COALESCE(NEW.is_spam, e.is_spam),
           e.feed_id, e.type
      INTO NEW.published_or_fetched_at, NEW.is_spam, v_feed_id, v_type
      FROM entries e
      WHERE e.id = NEW.entry_id;
    IF NEW.subscription_id IS NULL THEN
      SELECT s.id
        INTO NEW.subscription_id
        FROM subscriptions s
        WHERE s.user_id = NEW.user_id
          AND s.feed_id = v_feed_id;
    END IF;
  END IF;
  IF NEW.subscription_id IS NOT NULL THEN
    NEW.active_memberships := (
      SELECT count(*) FROM subscriptions s
      WHERE s.id = NEW.subscription_id AND s.unsubscribed_at IS NULL
    );
  ELSIF v_type = 'saved' THEN
    NEW.active_memberships := 1;
  END IF;
  RETURN NEW;
END;
$$;

-- Applies a change to the set of unread memberships (memberships whose article
-- is unread and not spam) to every counter they feed, plus per-user All and
-- Starred deltas the caller computed from user_entries rows. Each row is
-- (sign, user, entry, subscription): +1 when such a membership appears (it was
-- added, or its article became unread), -1 when one disappears. Runs after the
-- change, so the tables show the new state.
--
-- p_complete says the rows list every membership of their articles, with one
-- sign per article (the article itself changed); then what an article reaches
-- now is read from the rows. Otherwise (memberships changed) it's looked up.
--
-- Tags and Uncategorized count distinct articles: an article changes a list's
-- count only if the number of its active memberships reaching the list goes
-- between zero and non-zero.
CREATE FUNCTION apply_unread_memberships(
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

-- Tags and Uncategorized from scratch, for when what a list contains changes
-- wholesale (tagging, unsubscribing). Summing subscriptions' counters counts an
-- article once per membership, so it then subtracts the extra memberships of
-- the few unread articles with more than one (idx_user_entries_multi_member).
-- All needs no recompute: it's a function of each row, kept by the
-- user_entries triggers. Forced custom plans: a generic plan for the heaviest
-- user is several times slower (#1862).
CREATE OR REPLACE FUNCTION recompute_list_counters(p_user uuid) RETURNS void
    LANGUAGE plpgsql
    SET plan_cache_mode TO 'force_custom_plan'
    AS $$
DECLARE
  x_tag uuid[]; x_n integer[];
BEGIN
  PERFORM 1 FROM users WHERE id = p_user FOR NO KEY UPDATE;

  -- For each list (tag_id NULL is Uncategorized), how many more memberships
  -- than articles the unread multi-member articles bring to it.
  SELECT array_agg(tag_id), array_agg(n) INTO x_tag, x_n
  FROM (
    SELECT tag_id, sum(k - 1)::int AS n
    FROM (
      SELECT se.entry_id, st.tag_id, count(*) AS k
      FROM user_entries ue
      JOIN subscription_entries se ON se.user_id = ue.user_id AND se.entry_id = ue.entry_id
      JOIN subscriptions s ON s.id = se.subscription_id AND s.unsubscribed_at IS NULL
      LEFT JOIN subscription_tags st ON st.subscription_id = s.id
      WHERE ue.user_id = p_user AND ue.active_memberships > 1 AND NOT ue.read AND NOT ue.is_spam
        AND (st.tag_id IS NOT NULL OR s.type <> 'saved')
      GROUP BY se.entry_id, st.tag_id
    ) m
    WHERE k > 1
    GROUP BY tag_id
  ) x;

  UPDATE users u
  SET uncategorized_unread_count = f.n
  FROM (
    SELECT (
      SELECT COALESCE(sum(s.unread_count), 0)::int
      FROM subscriptions s
      WHERE s.user_id = p_user AND s.unsubscribed_at IS NULL AND s.type <> 'saved'
        AND NOT EXISTS (SELECT 1 FROM subscription_tags st WHERE st.subscription_id = s.id)
    ) - COALESCE((SELECT sum(x.n) FROM unnest(x_tag, x_n) AS x(tag_id, n) WHERE x.tag_id IS NULL), 0)::int AS n
  ) f
  WHERE u.id = p_user AND u.uncategorized_unread_count IS DISTINCT FROM f.n;

  UPDATE tags t
  SET unread_count = COALESCE(f.n, 0) - COALESCE(x.n, 0)
  FROM tags t2
  LEFT JOIN (
    SELECT st.tag_id, sum(s.unread_count)::int AS n
    FROM subscription_tags st
    JOIN subscriptions s ON s.id = st.subscription_id AND s.unsubscribed_at IS NULL
    WHERE s.user_id = p_user
    GROUP BY st.tag_id
  ) f ON f.tag_id = t2.id
  LEFT JOIN unnest(x_tag, x_n) AS x(tag_id, n) ON x.tag_id = t2.id
  WHERE t.id = t2.id AND t2.user_id = p_user
    AND t.unread_count IS DISTINCT FROM COALESCE(f.n, 0) - COALESCE(x.n, 0);
END;
$$;

-- A changed user_entries row: articles that became unread or read move every
-- counter their memberships feed; All and Starred follow the row itself.
CREATE FUNCTION user_entries_counters_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  m_sign integer[]; m_user uuid[]; m_entry uuid[]; m_sub uuid[];
  c_user uuid[]; c_all integer[]; c_starred integer[];
BEGIN
  SELECT array_agg(f.n), array_agg(se.user_id), array_agg(se.entry_id), array_agg(se.subscription_id)
  INTO m_sign, m_user, m_entry, m_sub
  FROM (
    SELECT user_id, entry_id, sum(sign)::int AS n
    FROM (
      SELECT 1 AS sign, user_id, entry_id FROM new_rows WHERE NOT read AND NOT is_spam
      UNION ALL
      SELECT -1, user_id, entry_id FROM old_rows WHERE NOT read AND NOT is_spam
    ) x
    GROUP BY user_id, entry_id
    HAVING sum(sign) <> 0
  ) f
  JOIN subscription_entries se ON se.user_id = f.user_id AND se.entry_id = f.entry_id;

  SELECT array_agg(user_id), array_agg(al), array_agg(st)
  INTO c_user, c_all, c_starred
  FROM (
    SELECT user_id, sum(al)::int AS al, sum(st)::int AS st
    FROM (
      SELECT user_id,
             (NOT read AND NOT is_spam AND (starred OR active_memberships > 0))::int AS al,
             (starred AND NOT read AND NOT is_spam)::int AS st
      FROM new_rows
      UNION ALL
      SELECT user_id,
             -((NOT read AND NOT is_spam AND (starred OR active_memberships > 0))::int),
             -((starred AND NOT read AND NOT is_spam)::int)
      FROM old_rows
    ) x
    GROUP BY user_id
    HAVING sum(al) <> 0 OR sum(st) <> 0
  ) d;

  PERFORM apply_unread_memberships(m_sign, m_user, m_entry, m_sub, true, c_user, c_all, c_starred);
  RETURN NULL;
END;
$$;

-- A new row's memberships are counted by the subscription_entries insert
-- trigger (the mirror adds them first); this counts the row's All and Starred.
CREATE FUNCTION user_entries_counters_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  c_user uuid[]; c_all integer[]; c_starred integer[];
BEGIN
  SELECT array_agg(user_id), array_agg(al), array_agg(st)
  INTO c_user, c_all, c_starred
  FROM (
    SELECT user_id,
           count(*) FILTER (WHERE NOT read AND NOT is_spam AND (starred OR active_memberships > 0))::int AS al,
           count(*) FILTER (WHERE starred AND NOT read AND NOT is_spam)::int AS st
    FROM new_rows
    GROUP BY user_id
  ) d
  WHERE al <> 0 OR st <> 0;

  PERFORM apply_unread_memberships(NULL, NULL, NULL, NULL, true, c_user, c_all, c_starred);
  RETURN NULL;
END;
$$;

-- A deleted row: count its memberships out, then remove them (and its
-- collection memberships, whose foreign key is likewise deferred).
CREATE FUNCTION user_entries_counters_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  m_sign integer[]; m_user uuid[]; m_entry uuid[]; m_sub uuid[];
  c_user uuid[]; c_all integer[]; c_starred integer[];
BEGIN
  SELECT array_agg(-1), array_agg(se.user_id), array_agg(se.entry_id), array_agg(se.subscription_id)
  INTO m_sign, m_user, m_entry, m_sub
  FROM old_rows o
  JOIN subscription_entries se ON se.user_id = o.user_id AND se.entry_id = o.entry_id
  WHERE NOT o.read AND NOT o.is_spam;

  SELECT array_agg(user_id), array_agg(al), array_agg(st)
  INTO c_user, c_all, c_starred
  FROM (
    SELECT user_id,
           -count(*) FILTER (WHERE NOT read AND NOT is_spam AND (starred OR active_memberships > 0))::int AS al,
           -count(*) FILTER (WHERE starred AND NOT read AND NOT is_spam)::int AS st
    FROM old_rows
    GROUP BY user_id
  ) d
  WHERE al <> 0 OR st <> 0;

  PERFORM apply_unread_memberships(m_sign, m_user, m_entry, m_sub, true, c_user, c_all, c_starred);

  DELETE FROM collection_entries ce
  USING old_rows o
  WHERE ce.user_id = o.user_id AND ce.entry_id = o.entry_id;
  DELETE FROM subscription_entries se
  USING old_rows o
  WHERE se.user_id = o.user_id AND se.entry_id = o.entry_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER user_entries_counters_insert_trigger
  AFTER INSERT ON user_entries
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION user_entries_counters_insert();
CREATE TRIGGER user_entries_counters_update_trigger
  AFTER UPDATE ON user_entries
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION user_entries_counters_update();
CREATE TRIGGER user_entries_counters_delete_trigger
  AFTER DELETE ON user_entries
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION user_entries_counters_delete();

-- Memberships added (+1) or removed (-1): count those of unread articles,
-- then recount each article's active memberships. The counters come first so
-- their locks (subscriptions, users, tags) precede the users lock the
-- user_entries update trigger takes; the user_entries rows themselves are
-- already held by whatever changed the memberships (src/server/CLAUDE.md).
-- Rows whose user_entries row is gone were counted by its delete trigger.
CREATE FUNCTION apply_membership_changes(
  p_sign integer, p_user uuid[], p_entry uuid[], p_sub uuid[]
) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF p_user IS NULL THEN
    RETURN;
  END IF;
  PERFORM apply_unread_memberships(array_agg(p_sign), array_agg(c.user_id), array_agg(c.entry_id),
                                   array_agg(c.subscription_id), false)
  FROM unnest(p_user, p_entry, p_sub) AS c(user_id, entry_id, subscription_id)
  JOIN user_entries ue ON ue.user_id = c.user_id AND ue.entry_id = c.entry_id
  WHERE NOT ue.read AND NOT ue.is_spam;

  UPDATE user_entries ue
  SET active_memberships = m.n
  FROM (
    SELECT p.user_id, p.entry_id, (
      SELECT count(*)::int
      FROM subscription_entries se
      JOIN subscriptions s ON s.id = se.subscription_id AND s.unsubscribed_at IS NULL
      WHERE se.user_id = p.user_id AND se.entry_id = p.entry_id
    ) AS n
    FROM (SELECT DISTINCT user_id, entry_id FROM unnest(p_user, p_entry) AS c(user_id, entry_id)) p
    WHERE EXISTS (
      SELECT 1 FROM user_entries x WHERE x.user_id = p.user_id AND x.entry_id = p.entry_id
    )
  ) m
  WHERE ue.user_id = m.user_id AND ue.entry_id = m.entry_id AND ue.active_memberships <> m.n;
END;
$$;

-- Memberships written by the mirror triggers until #1846 phase 7. The
-- user_entries insert mirror sets the transaction-local setting
-- lion.memberships to 'new_rows' around its writes: those are the memberships
-- of rows the statement inserted, which are all the memberships those
-- articles have and which the fill trigger already counted in
-- active_memberships, so they're counted from the rows alone, sparing a
-- fan-out a lookup per row.
CREATE FUNCTION subscription_entries_counters() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_mode text := current_setting('lion.memberships', true);
  v_sign integer := CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE -1 END;
  v_user uuid[]; v_entry uuid[]; v_sub uuid[];
BEGIN
  -- Statement triggers fire for no rows too, and this one updates user_entries,
  -- whose triggers may write memberships: stop the chain when nothing changed.
  IF NOT EXISTS (SELECT 1 FROM changed_rows) THEN
    RETURN NULL;
  END IF;
  IF v_mode = 'new_rows' THEN
    PERFORM apply_unread_memberships(array_agg(1), array_agg(c.user_id), array_agg(c.entry_id),
                                     array_agg(c.subscription_id), true)
    FROM changed_rows c
    JOIN user_entries ue ON ue.user_id = c.user_id AND ue.entry_id = c.entry_id
    WHERE NOT ue.read AND NOT ue.is_spam;
    RETURN NULL;
  END IF;
  SELECT array_agg(user_id), array_agg(entry_id), array_agg(subscription_id)
  INTO v_user, v_entry, v_sub
  FROM changed_rows;
  PERFORM apply_membership_changes(v_sign, v_user, v_entry, v_sub);
  RETURN NULL;
END;
$$;

CREATE TRIGGER subscription_entries_counters_insert_trigger
  AFTER INSERT ON subscription_entries
  REFERENCING NEW TABLE AS changed_rows
  FOR EACH STATEMENT EXECUTE FUNCTION subscription_entries_counters();
CREATE TRIGGER subscription_entries_counters_delete_trigger
  AFTER DELETE ON subscription_entries
  REFERENCING OLD TABLE AS changed_rows
  FOR EACH STATEMENT EXECUTE FUNCTION subscription_entries_counters();

-- The user_entries insert mirror of migration 0132, marking what it writes
-- for the trigger above (same body otherwise).
CREATE OR REPLACE FUNCTION user_entries_copy_memberships_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_users uuid[];
BEGIN
  PERFORM set_config('lion.memberships', 'new_rows', true);
  INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at)
  SELECT subscription_id, user_id, entry_id, published_or_fetched_at
  FROM new_rows
  WHERE subscription_id IS NOT NULL
  ON CONFLICT DO NOTHING;
  PERFORM set_config('lion.memberships', '', true);

  IF NOT EXISTS (SELECT 1 FROM new_rows WHERE subscription_id IS NULL) THEN
    RETURN NULL;
  END IF;

  SELECT array_agg(DISTINCT n.user_id) INTO v_users
  FROM new_rows n
  JOIN entries e ON e.id = n.entry_id
  WHERE n.subscription_id IS NULL AND e.type = 'saved';
  IF v_users IS NULL THEN
    RETURN NULL;
  END IF;

  -- A concurrent first save for the same user waits here on the unique index;
  -- the next statement's snapshot then sees whichever subscription won.
  PERFORM ensure_saved_subscriptions(v_users);

  PERFORM set_config('lion.memberships', 'new_rows', true);
  INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at)
  SELECT s.id, n.user_id, n.entry_id, n.published_or_fetched_at
  FROM new_rows n
  JOIN entries e ON e.id = n.entry_id
  JOIN subscriptions s ON s.user_id = n.user_id AND s.type = 'saved'
  WHERE n.subscription_id IS NULL AND e.type = 'saved'
  ON CONFLICT DO NOTHING;
  PERFORM set_config('lion.memberships', '', true);
  RETURN NULL;
END;
$$;

-- A redirect merge's re-stamp (subscription_id changed) adds the survivor's
-- membership and keeps the old one. Statement-level, so the survivor's
-- memberships are written, and counted, in one statement rather than one per
-- row; the cost is a pass over every update's changed rows. Named to fire
-- before the counter trigger.
CREATE OR REPLACE FUNCTION user_entries_copy_membership_restamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  r_user uuid[]; r_entry uuid[]; r_sub uuid[]; r_at timestamptz[];
BEGIN
  SELECT array_agg(user_id), array_agg(entry_id), array_agg(subscription_id), array_agg(at)
  INTO r_user, r_entry, r_sub, r_at
  FROM (
    SELECT user_id, entry_id, subscription_id, max(published_or_fetched_at) AS at
    FROM (
      SELECT 1 AS sign, user_id, entry_id, subscription_id, published_or_fetched_at FROM new_rows
      UNION ALL
      SELECT -1, user_id, entry_id, subscription_id, published_or_fetched_at FROM old_rows
    ) x
    WHERE subscription_id IS NOT NULL
    GROUP BY user_id, entry_id, subscription_id
    HAVING sum(sign) > 0
  ) r;
  IF r_user IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at)
  SELECT * FROM unnest(r_sub, r_user, r_entry, r_at)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER user_entries_copy_membership_restamp_trigger ON user_entries;
CREATE TRIGGER user_entries_copy_membership_restamp_trigger
  AFTER UPDATE ON user_entries
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION user_entries_copy_membership_restamp();

-- Unsubscribing or resubscribing moves each member article's
-- active_memberships (its user_entries row once; the app locks those rows
-- first), which moves All through the row trigger, and changes what the
-- user's tags and Uncategorized contain.
CREATE OR REPLACE FUNCTION subscriptions_recompute_lists() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  a_id uuid[]; a_user uuid[]; a_d integer[];
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

-- Starred, or in an active subscription. Same columns as before:
-- subscription_id (and its stream id) is still the article's source
-- subscription, which the previous release reads.
CREATE OR REPLACE VIEW visible_entries AS
 SELECT ue.user_id,
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
    e.full_content_hash,
    e.spam_score,
    e.is_spam,
    e.list_unsubscribe_mailto,
    e.list_unsubscribe_https,
    e.list_unsubscribe_post,
    e.created_at,
    GREATEST(e.updated_at, ue.updated_at) AS updated_at,
    e.full_content_original,
    e.full_content_cleaned,
    e.full_content_fetched_at,
    e.full_content_error,
    ue.read,
    ue.starred,
    s.id AS subscription_id,
    e.unsubscribe_url,
    ue.read_changed_at,
    ue.published_or_fetched_at,
    e.greader_item_id,
    s.greader_stream_id AS subscription_greader_stream_id,
    e.search_vector
   FROM user_entries ue
     JOIN entries e ON e.id = ue.entry_id
     LEFT JOIN subscriptions s ON s.id = ue.subscription_id
  WHERE ue.starred OR ue.active_memberships > 0;

-- Every counter, by the rules above.
UPDATE subscriptions s
SET unread_count = COALESCE(t.n, 0), starred_unread_count = 0
FROM subscriptions s2
LEFT JOIN (
  SELECT se.subscription_id, count(*)::int AS n
  FROM subscription_entries se
  JOIN user_entries ue ON ue.user_id = se.user_id AND ue.entry_id = se.entry_id
  WHERE NOT ue.read AND NOT ue.is_spam
  GROUP BY se.subscription_id
) t ON t.subscription_id = s2.id
WHERE s.id = s2.id
  AND (s.unread_count, s.starred_unread_count) IS DISTINCT FROM (COALESCE(t.n, 0), 0);

UPDATE users u
SET all_unread_count = COALESCE(t.al, 0),
    starred_unread_count = COALESCE(t.st, 0),
    saved_unread_count = COALESCE(sv.unread_count, 0)
FROM users u2
LEFT JOIN (
  SELECT user_id,
         count(*) FILTER (WHERE starred OR active_memberships > 0)::int AS al,
         count(*) FILTER (WHERE starred)::int AS st
  FROM user_entries
  WHERE NOT read AND NOT is_spam
  GROUP BY user_id
) t ON t.user_id = u2.id
LEFT JOIN subscriptions sv ON sv.user_id = u2.id AND sv.type = 'saved'
WHERE u.id = u2.id
  AND (u.all_unread_count, u.starred_unread_count, u.saved_unread_count)
    IS DISTINCT FROM (COALESCE(t.al, 0), COALESCE(t.st, 0), COALESCE(sv.unread_count, 0));

SELECT recompute_list_counters(id) FROM users ORDER BY id;
