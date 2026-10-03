-- Collections (#1806): a per-user feed (type 'collection') with a normal
-- subscriptions row, so tags, titles, unread counters and the sidebar treat it
-- like any feed. It has no entries of its own; collection_entries references
-- articles the user can already see, and user_entries.subscription_id keeps
-- pointing at each article's source.
--
-- Because an article can now reach a tag (or Uncategorized, or All) by more
-- than one route, those badges become stored counters of DISTINCT articles:
--
--   tags.unread_count               unread, non-spam articles reachable through
--                                   the tag's active feeds or its collections
--   users.uncategorized_unread_count  the same, through untagged ones
--   users.all_unread_count          unread, non-spam articles visible to the user
--                                   (active source, saved, starred, or collected)
--
-- They're a small incremental graph over the subscription counters:
--   - user_entries changes move them by ±1 per distinct target an article
--     reaches (apply_unread_rows). Articles in no collection have one route,
--     so they're applied in bulk grouped by source subscription; only
--     collection members are evaluated one by one.
--   - Structural changes (memberships, tag assignments, subscribing and
--     unsubscribing) recompute the user's counters (recompute_list_counters)
--     from the subscription counters plus their collection members, never
--     scanning a feed's history.
-- Lock order is subscriptions, then users, then tags, in every path, so the
-- recompute (which locks the users row first) serializes with concurrent
-- deltas for the same user instead of losing one.

SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
ALTER TABLE feeds DROP CONSTRAINT feed_type_user_id;
--> statement-breakpoint
ALTER TABLE feeds ADD CONSTRAINT feed_type_user_id
  CHECK ((type IN ('email', 'saved', 'collection')) = (user_id IS NOT NULL));
--> statement-breakpoint
-- Target of the (subscription_id, user_id) foreign key below, which stops a
-- membership row from pointing at another user's collection.
CREATE UNIQUE INDEX uq_subscriptions_id_user ON subscriptions (id, user_id);
--> statement-breakpoint
-- A member needs the user's user_entries row (that's what makes it visible to
-- them). The user_entries delete trigger below removes memberships itself,
-- after taking their contribution off the counters: a cascading foreign key
-- would delete them before any trigger could read the state. Deferred, so the
-- check runs after that trigger.
CREATE TABLE collection_entries (
  subscription_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (subscription_id, entry_id),
  FOREIGN KEY (subscription_id, user_id) REFERENCES subscriptions(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, entry_id) REFERENCES user_entries(user_id, entry_id)
    DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE INDEX idx_collection_entries_user_entry ON collection_entries (user_id, entry_id);
--> statement-breakpoint
ALTER TABLE tags ADD COLUMN unread_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE users
  ADD COLUMN uncategorized_unread_count integer NOT NULL DEFAULT 0,
  ADD COLUMN all_unread_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Applies signed contributions of counted (unread, non-spam) user_entries rows,
-- given as parallel arrays with each row's source subscription and starred
-- flag as of that contribution, to the tag, Uncategorized and All counters.
-- An article counts once per target however many routes reach it: its active
-- source subscription and every collection holding it.
CREATE FUNCTION apply_unread_rows(p_sign integer[], p_user uuid[], p_entry uuid[], p_sub uuid[], p_starred boolean[])
    RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  m_sign integer[]; m_user uuid[]; m_entry uuid[]; m_sub uuid[]; m_starred boolean[];
  n_n integer[]; n_user uuid[]; n_sub uuid[]; n_starred boolean[];
BEGIN
  IF p_sign IS NULL THEN
    RETURN;
  END IF;

  WITH c AS (
    SELECT x.*, EXISTS (
      SELECT 1 FROM collection_entries ce WHERE ce.user_id = x.user_id AND ce.entry_id = x.entry_id
    ) AS member
    FROM unnest(p_sign, p_user, p_entry, p_sub, p_starred) AS x(sign, user_id, entry_id, subscription_id, starred)
  ),
  plain AS (
    SELECT user_id, subscription_id, starred, sum(sign)::int AS n
    FROM c WHERE NOT member
    GROUP BY user_id, subscription_id, starred
    HAVING sum(sign) <> 0
  )
  SELECT
    (SELECT array_agg(sign) FROM c WHERE member),
    (SELECT array_agg(user_id) FROM c WHERE member),
    (SELECT array_agg(entry_id) FROM c WHERE member),
    (SELECT array_agg(subscription_id) FROM c WHERE member),
    (SELECT array_agg(starred) FROM c WHERE member),
    (SELECT array_agg(n) FROM plain),
    (SELECT array_agg(user_id) FROM plain),
    (SELECT array_agg(subscription_id) FROM plain),
    (SELECT array_agg(starred) FROM plain)
  INTO m_sign, m_user, m_entry, m_sub, m_starred, n_n, n_user, n_sub, n_starred;

  -- Articles in no collection reach targets only through their source.
  WITH plain AS (
    SELECT p.*, (s.id IS NOT NULL AND s.unsubscribed_at IS NULL) AS active,
           EXISTS (SELECT 1 FROM subscription_tags st WHERE st.subscription_id = p.subscription_id) AS tagged
    FROM unnest(n_n, n_user, n_sub, n_starred) AS p(n, user_id, subscription_id, starred)
    LEFT JOIN subscriptions s ON s.id = p.subscription_id
  ),
  members AS (
    SELECT m.*, (s.id IS NOT NULL AND s.unsubscribed_at IS NULL) AS active,
           EXISTS (SELECT 1 FROM subscription_tags st WHERE st.subscription_id = m.subscription_id) AS tagged
    FROM unnest(m_sign, m_user, m_entry, m_sub, m_starred) AS m(sign, user_id, entry_id, subscription_id, starred)
    LEFT JOIN subscriptions s ON s.id = m.subscription_id
  ),
  d AS (
    SELECT user_id, sum(uc)::int AS uc, sum(al)::int AS al
    FROM (
      SELECT user_id, CASE WHEN active AND NOT tagged THEN n ELSE 0 END AS uc,
             CASE WHEN active OR subscription_id IS NULL OR starred THEN n ELSE 0 END AS al
      FROM plain
      UNION ALL
      -- A collection member is always visible; it's Uncategorized if any route is.
      SELECT m.user_id,
             CASE WHEN (m.active AND NOT m.tagged) OR EXISTS (
               SELECT 1 FROM collection_entries ce
               WHERE ce.user_id = m.user_id AND ce.entry_id = m.entry_id
                 AND NOT EXISTS (SELECT 1 FROM subscription_tags st WHERE st.subscription_id = ce.subscription_id)
             ) THEN m.sign ELSE 0 END,
             m.sign
      FROM members m
    ) x
    GROUP BY user_id
    HAVING sum(uc) <> 0 OR sum(al) <> 0
  )
  UPDATE users u
  SET uncategorized_unread_count = u.uncategorized_unread_count + d.uc,
      all_unread_count = u.all_unread_count + d.al
  FROM d
  WHERE u.id = d.user_id;

  WITH plain AS (
    SELECT p.*
    FROM unnest(n_n, n_sub) AS p(n, subscription_id)
    JOIN subscriptions s ON s.id = p.subscription_id AND s.unsubscribed_at IS NULL
  ),
  routes AS (
    SELECT m.sign, m.user_id, m.entry_id, m.subscription_id AS route
    FROM unnest(m_sign, m_user, m_entry, m_sub) AS m(sign, user_id, entry_id, subscription_id)
    JOIN subscriptions s ON s.id = m.subscription_id AND s.unsubscribed_at IS NULL
    UNION ALL
    SELECT m.sign, m.user_id, m.entry_id, ce.subscription_id
    FROM unnest(m_sign, m_user, m_entry) AS m(sign, user_id, entry_id)
    JOIN collection_entries ce ON ce.user_id = m.user_id AND ce.entry_id = m.entry_id
  ),
  d AS (
    SELECT tag_id, sum(n)::int AS n
    FROM (
      SELECT st.tag_id, p.n FROM plain p JOIN subscription_tags st ON st.subscription_id = p.subscription_id
      UNION ALL
      SELECT tag_id, sign FROM (
        SELECT DISTINCT r.sign, r.user_id, r.entry_id, st.tag_id
        FROM routes r JOIN subscription_tags st ON st.subscription_id = r.route
      ) hits
    ) x
    GROUP BY tag_id
    HAVING sum(n) <> 0
  )
  UPDATE tags t
  SET unread_count = t.unread_count + d.n
  FROM d
  WHERE t.id = d.tag_id;
END;
$$;
--> statement-breakpoint
-- Recomputes a user's tag, Uncategorized and All counters from the
-- subscription counters plus their collection members. Each article is
-- counted through its active source when it has one, and through its
-- collections only otherwise, so nothing counts twice.
CREATE FUNCTION recompute_list_counters(p_user uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM 1 FROM users WHERE id = p_user FOR UPDATE;

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
    JOIN feeds fd ON fd.id = s.feed_id AND fd.type <> 'collection'
    WHERE s.user_id = p_user
  ) f,
  (
    SELECT
      count(DISTINCT ue.entry_id) FILTER (
        WHERE NOT EXISTS (SELECT 1 FROM subscription_tags st WHERE st.subscription_id = ce.subscription_id)
          AND NOT (src.unsubscribed_at IS NULL AND src.id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM subscription_tags st WHERE st.subscription_id = src.id))
      )::int AS uncategorized,
      -- Members not already counted as active-source, saved or starred orphans.
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
    JOIN feeds fd ON fd.id = s.feed_id AND fd.type <> 'collection'
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
--> statement-breakpoint
-- Collection counters: a collection's subscriptions.unread_count /
-- starred_unread_count count its unread, non-spam members, the same
-- contribution rule as the user_entries counters (migration 0092).
CREATE FUNCTION collection_entries_counters_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE subscriptions s
  SET unread_count = s.unread_count + d.u,
      starred_unread_count = s.starred_unread_count + d.su
  FROM (
    SELECT n.subscription_id,
           count(*) FILTER (WHERE NOT ue.read AND NOT ue.is_spam)::int AS u,
           count(*) FILTER (WHERE ue.starred AND NOT ue.read AND NOT ue.is_spam)::int AS su
    FROM new_rows n
    JOIN user_entries ue ON ue.user_id = n.user_id AND ue.entry_id = n.entry_id
    GROUP BY n.subscription_id
  ) d
  WHERE s.id = d.subscription_id AND (d.u <> 0 OR d.su <> 0);
  RETURN NULL;
END;
$$;

CREATE FUNCTION collection_entries_counters_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE subscriptions s
  SET unread_count = s.unread_count - d.u,
      starred_unread_count = s.starred_unread_count - d.su
  FROM (
    SELECT o.subscription_id,
           count(*) FILTER (WHERE NOT ue.read AND NOT ue.is_spam)::int AS u,
           count(*) FILTER (WHERE ue.starred AND NOT ue.read AND NOT ue.is_spam)::int AS su
    FROM old_rows o
    JOIN user_entries ue ON ue.user_id = o.user_id AND ue.entry_id = o.entry_id
    GROUP BY o.subscription_id
  ) d
  WHERE s.id = d.subscription_id AND (d.u <> 0 OR d.su <> 0);
  RETURN NULL;
END;
$$;

CREATE TRIGGER collection_entries_counters_insert_trigger AFTER INSERT ON collection_entries
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION collection_entries_counters_insert();

CREATE TRIGGER collection_entries_counters_delete_trigger AFTER DELETE ON collection_entries
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION collection_entries_counters_delete();
--> statement-breakpoint
-- Structural changes recompute the affected users' list counters.
CREATE FUNCTION collection_entries_recompute_lists() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM recompute_list_counters(u.user_id)
  FROM (SELECT DISTINCT user_id FROM changed_rows) u;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER collection_entries_recompute_lists_insert_trigger AFTER INSERT ON collection_entries
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION collection_entries_recompute_lists();
--> statement-breakpoint
CREATE TRIGGER collection_entries_recompute_lists_delete_trigger AFTER DELETE ON collection_entries
  REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION collection_entries_recompute_lists();
--> statement-breakpoint
CREATE FUNCTION subscription_tags_recompute_lists() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM recompute_list_counters(u.user_id)
  FROM (
    SELECT DISTINCT s.user_id FROM changed_rows c JOIN subscriptions s ON s.id = c.subscription_id
  ) u;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER subscription_tags_recompute_lists_insert_trigger AFTER INSERT ON subscription_tags
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION subscription_tags_recompute_lists();
--> statement-breakpoint
CREATE TRIGGER subscription_tags_recompute_lists_delete_trigger AFTER DELETE ON subscription_tags
  REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION subscription_tags_recompute_lists();
--> statement-breakpoint
-- Subscribing (insert) needs nothing: a new subscription's entries arrive
-- through user_entries inserts. Unsubscribing, resubscribing and deleting do.
-- Row-level for updates: a column-filtered trigger can't have transition
-- tables, and an unfiltered statement trigger would run on every counter
-- update.
CREATE FUNCTION subscriptions_recompute_lists() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM recompute_list_counters(NEW.user_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER subscriptions_recompute_lists_update_trigger
  AFTER UPDATE OF unsubscribed_at ON subscriptions
  FOR EACH ROW WHEN (OLD.unsubscribed_at IS DISTINCT FROM NEW.unsubscribed_at)
  EXECUTE FUNCTION subscriptions_recompute_lists();
--> statement-breakpoint
CREATE FUNCTION subscriptions_deleted_recompute_lists() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM recompute_list_counters(u.user_id) FROM (SELECT DISTINCT user_id FROM old_rows) u;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER subscriptions_recompute_lists_delete_trigger AFTER DELETE ON subscriptions
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION subscriptions_deleted_recompute_lists();
--> statement-breakpoint
-- Unsubscribing a collection, by any path, empties it, so its members stop
-- being visible through it and its counters drop to zero. Each removed
-- member's user_entries.updated_at moves so delta sync re-delivers it (or
-- reports it hidden).
CREATE FUNCTION subscriptions_empty_unsubscribed_collection() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  WITH removed AS (
    DELETE FROM collection_entries ce
    WHERE ce.subscription_id = NEW.id
    RETURNING ce.user_id, ce.entry_id
  )
  UPDATE user_entries ue
  SET updated_at = now()
  FROM removed r
  WHERE ue.user_id = r.user_id AND ue.entry_id = r.entry_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER subscriptions_empty_unsubscribed_collection_trigger
  AFTER UPDATE OF unsubscribed_at ON subscriptions
  FOR EACH ROW WHEN (OLD.unsubscribed_at IS NULL AND NEW.unsubscribed_at IS NOT NULL)
  EXECUTE FUNCTION subscriptions_empty_unsubscribed_collection();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION user_entries_counters_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE subscriptions s
  SET unread_count = s.unread_count - d.u,
      starred_unread_count = s.starred_unread_count - d.su
  FROM (
    SELECT subscription_id,
           count(*) FILTER (WHERE NOT read AND NOT is_spam)::int AS u,
           count(*) FILTER (WHERE starred AND NOT read AND NOT is_spam)::int AS su
    FROM old_rows
    WHERE subscription_id IS NOT NULL
    GROUP BY subscription_id
  ) d
  WHERE s.id = d.subscription_id AND (d.u <> 0 OR d.su <> 0);

  UPDATE subscriptions s
  SET unread_count = s.unread_count - d.u,
      starred_unread_count = s.starred_unread_count - d.su
  FROM (
    SELECT ce.subscription_id,
           count(*) FILTER (WHERE NOT o.read AND NOT o.is_spam)::int AS u,
           count(*) FILTER (WHERE o.starred AND NOT o.read AND NOT o.is_spam)::int AS su
    FROM old_rows o
    JOIN collection_entries ce ON ce.user_id = o.user_id AND ce.entry_id = o.entry_id
    GROUP BY ce.subscription_id
  ) d
  WHERE s.id = d.subscription_id AND (d.u <> 0 OR d.su <> 0);

  UPDATE users usr
  SET saved_unread_count = usr.saved_unread_count - d.sv,
      starred_unread_count = usr.starred_unread_count - d.st
  FROM (
    SELECT user_id,
           count(*) FILTER (WHERE subscription_id IS NULL AND NOT read AND NOT is_spam)::int AS sv,
           count(*) FILTER (WHERE starred AND NOT read AND NOT is_spam)::int AS st
    FROM old_rows
    GROUP BY user_id
  ) d
  WHERE usr.id = d.user_id AND (d.sv <> 0 OR d.st <> 0);

  -- Runs while the memberships still exist, so it sees every route.
  PERFORM apply_unread_rows(array_agg(-1), array_agg(user_id), array_agg(entry_id),
                            array_agg(subscription_id), array_agg(starred))
  FROM old_rows
  WHERE NOT read AND NOT is_spam;

  -- Already taken off above, so the membership triggers find no user_entries
  -- row left to count.
  DELETE FROM collection_entries ce
  USING old_rows o
  WHERE ce.user_id = o.user_id AND ce.entry_id = o.entry_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION user_entries_counters_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE subscriptions s
  SET unread_count = s.unread_count + d.u,
      starred_unread_count = s.starred_unread_count + d.su
  FROM (
    SELECT subscription_id,
           count(*) FILTER (WHERE NOT read AND NOT is_spam)::int AS u,
           count(*) FILTER (WHERE starred AND NOT read AND NOT is_spam)::int AS su
    FROM new_rows
    WHERE subscription_id IS NOT NULL
    GROUP BY subscription_id
  ) d
  WHERE s.id = d.subscription_id AND (d.u <> 0 OR d.su <> 0);

  UPDATE users usr
  SET saved_unread_count = usr.saved_unread_count + d.sv,
      starred_unread_count = usr.starred_unread_count + d.st
  FROM (
    SELECT user_id,
           count(*) FILTER (WHERE subscription_id IS NULL AND NOT read AND NOT is_spam)::int AS sv,
           count(*) FILTER (WHERE starred AND NOT read AND NOT is_spam)::int AS st
    FROM new_rows
    GROUP BY user_id
  ) d
  WHERE usr.id = d.user_id AND (d.sv <> 0 OR d.st <> 0);

  -- A new user_entries row can't be in a collection yet (membership needs it),
  -- so collection counters don't move here.
  PERFORM apply_unread_rows(array_agg(1), array_agg(user_id), array_agg(entry_id),
                            array_agg(subscription_id), array_agg(starred))
  FROM new_rows
  WHERE NOT read AND NOT is_spam;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION user_entries_counters_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE subscriptions s
  SET unread_count = s.unread_count + d.u,
      starred_unread_count = s.starred_unread_count + d.su
  FROM (
    SELECT subscription_id, sum(u)::int AS u, sum(su)::int AS su
    FROM (
      SELECT subscription_id,
             (NOT read AND NOT is_spam)::int AS u,
             (starred AND NOT read AND NOT is_spam)::int AS su
      FROM new_rows
      WHERE subscription_id IS NOT NULL
      UNION ALL
      SELECT subscription_id,
             -((NOT read AND NOT is_spam)::int),
             -((starred AND NOT read AND NOT is_spam)::int)
      FROM old_rows
      WHERE subscription_id IS NOT NULL
    ) x
    GROUP BY subscription_id
    HAVING sum(u) <> 0 OR sum(su) <> 0
  ) d
  WHERE s.id = d.subscription_id;

  -- Collection counters, for rows whose counted state changed. Old and new
  -- rows are netted by grouping, never joined: the planner has no statistics
  -- for transition tables and a join can turn into a quadratic nested loop.
  UPDATE subscriptions s
  SET unread_count = s.unread_count + d.u,
      starred_unread_count = s.starred_unread_count + d.su
  FROM (
    SELECT ce.subscription_id, sum(x.u)::int AS u, sum(x.su)::int AS su
    FROM (
      SELECT user_id, entry_id, sum(u) AS u, sum(su) AS su
      FROM (
        SELECT user_id, entry_id,
               (NOT read AND NOT is_spam)::int AS u,
               (starred AND NOT read AND NOT is_spam)::int AS su
        FROM new_rows
        UNION ALL
        SELECT user_id, entry_id,
               -((NOT read AND NOT is_spam)::int),
               -((starred AND NOT read AND NOT is_spam)::int)
        FROM old_rows
      ) y
      GROUP BY user_id, entry_id
      HAVING sum(u) <> 0 OR sum(su) <> 0
    ) x
    JOIN collection_entries ce ON ce.user_id = x.user_id AND ce.entry_id = x.entry_id
    GROUP BY ce.subscription_id
    HAVING sum(x.u) <> 0 OR sum(x.su) <> 0
  ) d
  WHERE s.id = d.subscription_id;

  UPDATE users usr
  SET saved_unread_count = usr.saved_unread_count + d.sv,
      starred_unread_count = usr.starred_unread_count + d.st
  FROM (
    SELECT user_id, sum(sv)::int AS sv, sum(st)::int AS st
    FROM (
      SELECT user_id,
             (subscription_id IS NULL AND NOT read AND NOT is_spam)::int AS sv,
             (starred AND NOT read AND NOT is_spam)::int AS st
      FROM new_rows
      UNION ALL
      SELECT user_id,
             -((subscription_id IS NULL AND NOT read AND NOT is_spam)::int),
             -((starred AND NOT read AND NOT is_spam)::int)
      FROM old_rows
    ) x
    GROUP BY user_id
    HAVING sum(sv) <> 0 OR sum(st) <> 0
  ) d
  WHERE usr.id = d.user_id;

  -- Old contribution out, new one in; rows whose counted state and source
  -- didn't change net to zero and drop out.
  PERFORM apply_unread_rows(array_agg(x.n), array_agg(x.user_id), array_agg(x.entry_id),
                            array_agg(x.subscription_id), array_agg(x.starred))
  FROM (
    SELECT user_id, entry_id, subscription_id, starred, sum(sign)::int AS n
    FROM (
      SELECT 1 AS sign, user_id, entry_id, subscription_id, starred
      FROM new_rows WHERE NOT read AND NOT is_spam
      UNION ALL
      SELECT -1, user_id, entry_id, subscription_id, starred
      FROM old_rows WHERE NOT read AND NOT is_spam
    ) y
    GROUP BY user_id, entry_id, subscription_id, starred
    HAVING sum(sign) <> 0
  ) x;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- Backfill. CREATE TRIGGER above holds SHARE ROW EXCLUSIVE on user_entries,
-- subscriptions and subscription_tags until commit, so writers wait and the
-- counters start exact.
SELECT recompute_list_counters(id) FROM users;
--> statement-breakpoint
-- Articles in one of the user's collections stay visible after the user
-- unsubscribes from their source, like starred ones.
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
   FROM ((user_entries ue
     JOIN entries e ON ((e.id = ue.entry_id)))
     LEFT JOIN subscriptions s ON ((s.id = ue.subscription_id)))
  WHERE (((s.id IS NOT NULL) AND (s.unsubscribed_at IS NULL)) OR (ue.starred = true) OR (e.type = 'saved'::feed_type)
    OR (EXISTS (SELECT 1 FROM collection_entries ce WHERE ce.user_id = ue.user_id AND ce.entry_id = ue.entry_id)));
