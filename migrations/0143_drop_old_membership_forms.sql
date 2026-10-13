-- #1846 phase 7B: memberships (subscription_entries) are the only form. The
-- previous release writes them directly and names none of what this drops:
-- the mirror triggers, user_entries.subscription_id (with its fill, index and
-- foreign key) and collection_entries. Catalog only.
SET LOCAL lock_timeout = '5s';

-- In the app's lock order, so a transaction holding a later one can't make
-- this wait on it while it waits on us.
LOCK TABLE user_entries, collection_entries IN ACCESS EXCLUSIVE MODE;
LOCK TABLE subscriptions IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER user_entries_copy_memberships_insert_trigger ON user_entries;
DROP TRIGGER user_entries_copy_membership_restamp_trigger ON user_entries;
DROP FUNCTION user_entries_copy_memberships_insert();
DROP FUNCTION user_entries_copy_membership_restamp();

-- Fills only what every insert path passes anyway (insertUserEntriesWithMemberships),
-- for rows inserted by hand. active_memberships is the membership triggers'.
CREATE OR REPLACE FUNCTION user_entries_fill_denormalized() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.published_or_fetched_at IS NULL OR NEW.is_spam IS NULL THEN
    SELECT COALESCE(NEW.published_or_fetched_at, e.published_at, e.fetched_at),
           COALESCE(NEW.is_spam, e.is_spam)
      INTO NEW.published_or_fetched_at, NEW.is_spam
      FROM entries e
      WHERE e.id = NEW.entry_id;
  END IF;
  RETURN NEW;
END;
$$;

-- Without the mirror's 'new_rows' shortcut, which only its inserts could use.
CREATE OR REPLACE FUNCTION subscription_entries_counters() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_sign integer := CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE -1 END;
  v_user uuid[]; v_entry uuid[]; v_sub uuid[];
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
    PERFORM 1 FROM subscriptions
    WHERE id IN (SELECT DISTINCT subscription_id FROM changed_rows)
    ORDER BY id FOR NO KEY UPDATE;
  END IF;
  SELECT array_agg(user_id), array_agg(entry_id), array_agg(subscription_id)
  INTO v_user, v_entry, v_sub
  FROM changed_rows;
  PERFORM apply_membership_changes(v_sign, v_user, v_entry, v_sub);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION user_entries_counters_delete() RETURNS trigger
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

  DELETE FROM subscription_entries se
  USING old_rows o
  WHERE se.user_id = o.user_id AND se.entry_id = o.entry_id;
  RETURN NULL;
END;
$$;

-- An entry's subscriptions come from its memberships (entryOriginJoin).
DROP VIEW visible_entries;
CREATE VIEW visible_entries AS
 SELECT ue.user_id,
    e.id,
    e.owner_feed_id,
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
    e.unsubscribe_url,
    ue.read_changed_at,
    ue.published_or_fetched_at,
    e.greader_item_id,
    e.search_vector
   FROM user_entries ue
     JOIN entries e ON e.id = ue.entry_id
  WHERE ue.starred OR ue.active_memberships > 0;

-- Its index and foreign key go with it.
ALTER TABLE user_entries DROP COLUMN subscription_id;

-- Its triggers and foreign keys go with it.
DROP TABLE collection_entries;
DROP FUNCTION collection_entries_copy_memberships_insert();
DROP FUNCTION collection_entries_copy_memberships_delete();
