-- Memberships for every subscription type (#1846, phase 4B): which articles
-- each subscription holds, in one table. It replaces user_entries.subscription_id
-- and collection_entries later; for now nothing reads it, and triggers keep it
-- a copy of those two plus the saved articles, each of which joins the user's
-- saved subscription (created here on first save).
--
-- Adding the foreign keys and triggers locks user_entries and collection_entries
-- against writes, and the check needs ACCESS EXCLUSIVE on subscriptions, which
-- also queues its reads until we commit or lock_timeout fails us. Take them up
-- front in the counter triggers' order (user_entries, then subscriptions).
-- A transaction that already holds a later lock can still deadlock with us;
-- Postgres then aborts one side, and if that's the migration, re-running the
-- deploy retries it. Every table touched is empty or small apart from
-- user_entries, which is only locked, never scanned.
SET LOCAL lock_timeout = '5s';
LOCK TABLE user_entries, collection_entries IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE subscriptions IN ACCESS EXCLUSIVE MODE;

-- The saved subscription has no feed, so user_entries_fill_denormalized
-- (which finds a subscription by the entry's feed) never stamps saved articles
-- with it: they keep subscription_id NULL and users.saved_unread_count keeps
-- counting them, once. The check makes that a rule.
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_saved_feedless CHECK (type <> 'saved' OR feed_id IS NULL);
CREATE UNIQUE INDEX uq_subscriptions_saved_user ON subscriptions (user_id) WHERE type = 'saved';

CREATE TABLE subscription_entries (
  subscription_id uuid NOT NULL,
  user_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  -- user_entries.published_or_fetched_at, which never changes after insert.
  published_or_fetched_at timestamptz NOT NULL,
  PRIMARY KEY (subscription_id, entry_id),
  FOREIGN KEY (subscription_id, user_id) REFERENCES subscriptions (id, user_id) ON DELETE CASCADE,
  -- ON UPDATE too, for re-keying user_entries onto a surviving duplicate
  -- entry, which migration 0109 did (its replay test still does). Such a
  -- re-key must also rewrite the copied published_or_fetched_at, or the daily
  -- check reports the rows as misdated.
  FOREIGN KEY (user_id, entry_id) REFERENCES user_entries (user_id, entry_id)
    ON DELETE CASCADE ON UPDATE CASCADE
);
-- A subscription's timeline, newest first.
CREATE INDEX idx_subscription_entries_timeline
  ON subscription_entries (subscription_id, published_or_fetched_at DESC, entry_id DESC);
-- The subscriptions holding an article.
CREATE INDEX idx_subscription_entries_user_entry ON subscription_entries (user_id, entry_id);

-- Gives each of these users with a saved feed their saved subscription, if
-- they don't have one: no feed, named "Saved", with the saved feed's Google
-- Reader serial so its feed/{n} stream id stays the same once it's listed.
-- Returns how many it created.
CREATE FUNCTION ensure_saved_subscriptions(p_users uuid[]) RETURNS integer
    LANGUAGE sql
    AS $$
  WITH created AS (
    INSERT INTO subscriptions (id, user_id, type, custom_title, greader_stream_id,
                               subscribed_at, created_at, updated_at)
    SELECT uuidv7(), f.user_id, 'saved', 'Saved', f.greader_stream_id, f.created_at, now(), now()
    FROM feeds f
    WHERE f.type = 'saved' AND f.user_id = ANY (p_users)
    ORDER BY f.user_id
    ON CONFLICT (user_id) WHERE type = 'saved' DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer FROM created;
$$;

-- The mirror triggers write memberships inside the statement that changes
-- user_entries or collection_entries, before the counter triggers (they sort
-- first by name, and row triggers fire before statement ones), so their locks
-- follow the lock order: user_entries rows, subscription_entries,
-- subscriptions, users, tags. The one exception is a user's first save, which
-- inserts the saved subscription before its membership; that new row can only
-- be contended by another first save for the same user, which waits on the
-- unique index before taking any other lock. Every write is idempotent.

-- A new user_entries row joins its source subscription, or for a saved
-- article (subscription_id NULL) the user's saved subscription.
CREATE FUNCTION user_entries_copy_memberships_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_users uuid[];
BEGIN
  INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at)
  SELECT subscription_id, user_id, entry_id, published_or_fetched_at
  FROM new_rows
  WHERE subscription_id IS NOT NULL
  ON CONFLICT DO NOTHING;

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

  INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at)
  SELECT s.id, n.user_id, n.entry_id, n.published_or_fetched_at
  FROM new_rows n
  JOIN entries e ON e.id = n.entry_id
  JOIN subscriptions s ON s.user_id = n.user_id AND s.type = 'saved'
  WHERE n.subscription_id IS NULL AND e.type = 'saved'
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER user_entries_copy_memberships_insert_trigger
  AFTER INSERT ON user_entries
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION user_entries_copy_memberships_insert();

-- A redirect merge re-stamps the old subscription's rows onto the survivor:
-- the article joins the survivor and stays in the old subscription. A
-- column-filtered trigger can't see transition tables, so this is per row;
-- only re-stamps name subscription_id, so other updates never fire it.
CREATE FUNCTION user_entries_copy_membership_restamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at)
  VALUES (NEW.subscription_id, NEW.user_id, NEW.entry_id, NEW.published_or_fetched_at)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER user_entries_copy_membership_restamp_trigger
  AFTER UPDATE OF subscription_id ON user_entries
  FOR EACH ROW
  WHEN (NEW.subscription_id IS NOT NULL AND NEW.subscription_id IS DISTINCT FROM OLD.subscription_id)
  EXECUTE FUNCTION user_entries_copy_membership_restamp();

CREATE FUNCTION collection_entries_copy_memberships_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at)
  SELECT n.subscription_id, n.user_id, n.entry_id, ue.published_or_fetched_at
  FROM new_rows n
  JOIN user_entries ue ON ue.user_id = n.user_id AND ue.entry_id = n.entry_id
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER collection_entries_copy_memberships_insert_trigger
  AFTER INSERT ON collection_entries
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION collection_entries_copy_memberships_insert();

CREATE FUNCTION collection_entries_copy_memberships_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM subscription_entries se
  USING old_rows o
  WHERE se.subscription_id = o.subscription_id AND se.entry_id = o.entry_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER collection_entries_copy_memberships_delete_trigger
  AFTER DELETE ON collection_entries
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION collection_entries_copy_memberships_delete();
