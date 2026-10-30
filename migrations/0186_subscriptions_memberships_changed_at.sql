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
-- the fan-out's inserts (feed subscriptions only) update nothing more. A
-- delete now takes the same lock, so the stamp never locks a subscription
-- after users or tags.
-- Statements over the transition table are EXECUTEd, so a plan cached for one
-- statement's size isn't reused for another's.
CREATE OR REPLACE FUNCTION subscription_entries_counters() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  v_sign integer := CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE -1 END;
  v_any boolean;
  v_user uuid[]; v_entry uuid[]; v_sub uuid[];
  v_collections uuid[];
BEGIN
  -- Statement triggers fire for no rows too, and this one updates user_entries:
  -- stop when nothing changed.
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM changed_rows)' INTO v_any;
  IF NOT v_any THEN
    RETURN NULL;
  END IF;
  -- A membership added while its subscription is being (un)subscribed: that
  -- statement's trigger can't see this uncommitted membership, so this one
  -- must see its outcome. Lock the subscriptions (sorted; they follow the
  -- memberships in the lock order), so everything below reads them settled.
  -- A delete takes the same locks, before the counters lock users and tags:
  -- the collections among them are stamped at the end.
  EXECUTE $q$
    SELECT array_agg(id) FILTER (WHERE type = 'collection')
    FROM (
      SELECT id, type FROM subscriptions
      WHERE id IN (SELECT DISTINCT subscription_id FROM changed_rows)
      ORDER BY id FOR NO KEY UPDATE
    ) s
  $q$ INTO v_collections;
  EXECUTE $q$
    SELECT array_agg(user_id), array_agg(entry_id), array_agg(subscription_id) FROM changed_rows
  $q$ INTO v_user, v_entry, v_sub;
  PERFORM apply_membership_changes(v_sign, v_user, v_entry, v_sub);
  IF v_collections IS NOT NULL THEN
    UPDATE subscriptions SET memberships_changed_at = now() WHERE id = ANY(v_collections);
  END IF;
  RETURN NULL;
END;
$_$;

-- Deleting an article deletes its memberships last, after the counters lock
-- users and tags, and that delete's trigger now locks their subscriptions to
-- stamp the collections. Lock those subscriptions first instead, so they come
-- before users and tags here too. Otherwise unchanged.
CREATE OR REPLACE FUNCTION user_entries_counters_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  m_sign integer[]; m_user uuid[]; m_entry uuid[]; m_sub uuid[];
  c_user uuid[]; c_all integer[]; c_starred integer[];
BEGIN
  EXECUTE $q$
    SELECT 1 FROM subscriptions
    WHERE id IN (
      SELECT se.subscription_id
      FROM old_rows o
      JOIN subscription_entries se ON se.user_id = o.user_id AND se.entry_id = o.entry_id
    )
    ORDER BY id FOR NO KEY UPDATE
  $q$;

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

  DELETE FROM subscription_entries se
  USING old_rows o
  WHERE se.user_id = o.user_id AND se.entry_id = o.entry_id;
  RETURN NULL;
END;
$_$;
