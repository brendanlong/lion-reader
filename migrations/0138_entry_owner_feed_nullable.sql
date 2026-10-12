-- Email and saved articles stop naming per-user feeds (#1846 phase 6B2),
-- step 1 of 4 (0138–0141, split so no step holds entries' ACCESS EXCLUSIVE
-- lock for more than a moment):
--   0138 drops owner_feed_id's NOT NULL, which tells the previous release
--        (6B1) to stop writing per-user feeds (personalFeedsRequired);
--   0139 clears owner_feed_id on email and saved entries;
--   0140 deletes the email and saved feeds and adds the checks;
--   0141 validates the exactly-one-owner check.
--
-- The first two functions below no longer need the per-user feeds, so a
-- first save or email between these steps works whether or not they exist.
-- The third lets an email subscription's hard delete (account deletion)
-- cascade to its emails, which now nothing else deletes (#1897).
SET LOCAL lock_timeout = '5s';

ALTER TABLE entries ALTER COLUMN owner_feed_id DROP NOT NULL;

-- An email's user_entries row gets its subscription from the entry's owner;
-- a web entry's from the user's subscription to its feed, as before.
CREATE OR REPLACE FUNCTION user_entries_fill_denormalized() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_feed_id uuid;
  v_owner_subscription_id uuid;
  v_type feed_type;
BEGIN
  IF NEW.published_or_fetched_at IS NULL
     OR NEW.is_spam IS NULL
     OR NEW.subscription_id IS NULL THEN
    SELECT COALESCE(NEW.published_or_fetched_at, e.published_at, e.fetched_at),
           COALESCE(NEW.is_spam, e.is_spam),
           e.owner_feed_id, e.owner_subscription_id, e.type
      INTO NEW.published_or_fetched_at, NEW.is_spam, v_feed_id, v_owner_subscription_id, v_type
      FROM entries e
      WHERE e.id = NEW.entry_id;
    IF NEW.subscription_id IS NULL THEN
      IF v_owner_subscription_id IS NOT NULL THEN
        SELECT s.id
          INTO NEW.subscription_id
          FROM subscriptions s
          WHERE s.id = v_owner_subscription_id
            AND s.user_id = NEW.user_id;
      ELSIF v_feed_id IS NOT NULL THEN
        SELECT s.id
          INTO NEW.subscription_id
          FROM subscriptions s
          WHERE s.user_id = NEW.user_id
            AND s.feed_id = v_feed_id;
      END IF;
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

-- A first save creates the saved subscription without a saved feed.
CREATE OR REPLACE FUNCTION ensure_saved_subscriptions(p_users uuid[]) RETURNS integer
    LANGUAGE sql
    AS $$
  WITH created AS (
    INSERT INTO subscriptions (id, user_id, type, custom_title, subscribed_at, created_at, updated_at)
    SELECT uuidv7(), u.user_id, 'saved', 'Saved', now(), now(), now()
    FROM (SELECT DISTINCT user_id FROM unnest(p_users) AS u(user_id)) u
    ORDER BY u.user_id
    ON CONFLICT (user_id) WHERE type = 'saved' DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer FROM created;
$$;

-- A cascade that deletes entries (an email subscription's, through
-- owner_subscription_id) removes their memberships before their user_entries
-- rows, which cascade later: skip those rows rather than update one whose
-- entry is gone, which fails its foreign key (#1897).
CREATE OR REPLACE FUNCTION apply_membership_changes(p_sign integer, p_user uuid[], p_entry uuid[], p_sub uuid[]) RETURNS void
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
      AND EXISTS (SELECT 1 FROM entries e WHERE e.id = p.entry_id)
  ) m
  WHERE ue.user_id = m.user_id AND ue.entry_id = m.entry_id AND ue.active_memberships <> m.n;
END;
$$;
