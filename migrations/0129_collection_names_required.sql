-- Every collection has a name on its subscription (#1846, phase 2B). The
-- release before 0128's code wrote the name only to feeds.title, so the
-- collections it created during that rollout have a NULL custom_title, which
-- uq_subscriptions_user_collection_name ignores; one may share a name
-- (ignoring case) with another active collection of the same user.
-- ADD CONSTRAINT takes an ACCESS EXCLUSIVE lock on a table the counter
-- triggers update constantly; fail fast rather than queue every write behind
-- it.
SET LOCAL lock_timeout = '5s';

-- 1. Rename the clashes, so filling the names in step 2 can't violate the
-- unique index. Within each group of active collections sharing a displayed
-- name ignoring case, a collection that already stores its name keeps it
-- (the index allows at most one), else the oldest; the others, oldest first,
-- get "Name (2)", "Name (3)", … with the first number whose result is free
-- ignoring case. The displayed name changes, so updated_at moves and delta
-- sync re-delivers them.
DO $$
DECLARE
  clash record;
  candidate text;
  n integer;
BEGIN
  FOR clash IN
    SELECT ranked.id, ranked.user_id, ranked.name
    FROM (
      SELECT s.id, s.user_id, s.created_at,
        COALESCE(s.custom_title, f.title) AS name,
        row_number() OVER (
          PARTITION BY s.user_id, lower(COALESCE(s.custom_title, f.title))
          ORDER BY s.custom_title IS NULL, s.created_at, s.id
        ) AS rank
      FROM subscriptions s
      JOIN feeds f ON f.id = s.feed_id
      WHERE s.type = 'collection' AND s.unsubscribed_at IS NULL
    ) ranked
    WHERE ranked.rank > 1
    ORDER BY ranked.created_at, ranked.id
  LOOP
    n := 2;
    LOOP
      candidate := clash.name || ' (' || n || ')';
      EXIT WHEN NOT EXISTS (
        SELECT 1
        FROM subscriptions o
        JOIN feeds f ON f.id = o.feed_id
        WHERE o.user_id = clash.user_id
          AND o.type = 'collection'
          AND o.unsubscribed_at IS NULL
          AND lower(COALESCE(o.custom_title, f.title)) = lower(candidate)
      );
      n := n + 1;
    END LOOP;
    UPDATE subscriptions SET custom_title = candidate, updated_at = now() WHERE id = clash.id;
  END LOOP;
END $$;

-- 2. Copy the remaining collections' displayed name (active or not, so a
-- deleted collection keeps its name). It doesn't change, so updated_at
-- doesn't move.
UPDATE subscriptions s
SET custom_title = f.title
FROM feeds f
WHERE f.id = s.feed_id AND s.type = 'collection' AND s.custom_title IS NULL;

-- 3. The previous release (0128's code) always writes a collection's name.
-- The table is small, so validating in place is instant.
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_collection_named
  CHECK (type <> 'collection' OR custom_title IS NOT NULL);
