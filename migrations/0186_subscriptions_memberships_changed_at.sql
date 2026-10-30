-- When each collection's memberships last changed, so a sync catch-up sends
-- the counts of only the collections that changed since it started (#2232).
-- NULL: none since this column was added. Nothing is backfilled: a client
-- loaded before this migration has its own (previous release's) refresh, and
-- one loaded after it starts from counts read after it.
--
-- The previous release neither reads nor writes the column; the trigger
-- stamps it for whichever release made the change.
SET LOCAL lock_timeout = '5s';

ALTER TABLE subscriptions ADD COLUMN memberships_changed_at timestamptz;

-- A catch-up's lookup reads only the collections stamped since its start, not
-- every subscription the user has.
CREATE INDEX idx_subscriptions_user_memberships_changed
  ON subscriptions (user_id, memberships_changed_at)
  WHERE type = 'collection' AND unsubscribed_at IS NULL;

-- Stamps the collections among the changed memberships' subscriptions. An
-- insert finds them with the lock it already takes on those subscriptions, so
-- the fan-out's inserts (feed subscriptions only) update nothing more.
CREATE OR REPLACE FUNCTION subscription_entries_counters() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_sign integer := CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE -1 END;
  v_user uuid[]; v_entry uuid[]; v_sub uuid[];
  v_collections uuid[];
BEGIN
  -- Statement triggers fire for no rows too, and this one updates user_entries:
  -- stop when nothing changed.
  IF NOT EXISTS (SELECT 1 FROM changed_rows) THEN
    RETURN NULL;
  END IF;
  -- A membership added while its subscription is being (un)subscribed: that
  -- statement's trigger can't see this uncommitted membership, so this one
  -- must see its outcome. Lock the subscriptions (sorted; they follow the
  -- memberships in the lock order), so everything below reads them settled.
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(id) FILTER (WHERE type = 'collection') INTO v_collections
    FROM (
      SELECT id, type FROM subscriptions
      WHERE id IN (SELECT DISTINCT subscription_id FROM changed_rows)
      ORDER BY id FOR NO KEY UPDATE
    ) s;
  ELSE
    SELECT array_agg(id) INTO v_collections
    FROM subscriptions
    WHERE id IN (SELECT DISTINCT subscription_id FROM changed_rows) AND type = 'collection';
  END IF;
  SELECT array_agg(user_id), array_agg(entry_id), array_agg(subscription_id)
  INTO v_user, v_entry, v_sub
  FROM changed_rows;
  PERFORM apply_membership_changes(v_sign, v_user, v_entry, v_sub);
  IF v_collections IS NOT NULL THEN
    UPDATE subscriptions SET memberships_changed_at = now() WHERE id = ANY(v_collections);
  END IF;
  RETURN NULL;
END;
$$;
