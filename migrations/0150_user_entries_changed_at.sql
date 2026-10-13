-- user_entries.changed_at: when anything delta sync reports about a user's
-- entry last changed, GREATEST(entries.updated_at, user_entries.updated_at)
-- kept per user so one index serves sync's keyset (#1846 follow-up). Triggers,
-- not app code, keep it: a content change has to reach every holder's row
-- whichever path (or release, during a rollout) wrote it.
--
-- The previous release reads none of this, and visible_entries.updated_at
-- keeps its value, now read from the column. Its sync still seeks
-- idx_user_entries_updated_at, so that index stays until a later release
-- (a rolled-back deploy runs it on this schema indefinitely).
--
-- Locks: adding the column takes ACCESS EXCLUSIVE on user_entries, so every
-- read and write of it waits for the backfill and rewrite (about 12 s at
-- production's size on a dedicated core): deploy at a quiet time or with
-- maintenance mode on.
SET LOCAL lock_timeout = '5s';

-- Every lock up front, in the order readers take them (the view, then its
-- tables), so no statement below upgrades one while a reader waits.
LOCK TABLE visible_entries IN ACCESS EXCLUSIVE MODE;
LOCK TABLE user_entries, entries IN ACCESS EXCLUSIVE MODE;

-- A constant default adds the column without a rewrite; the backfill sets it.
ALTER TABLE user_entries ADD COLUMN changed_at timestamptz DEFAULT now() NOT NULL;

UPDATE user_entries ue
SET changed_at = GREATEST(ue.updated_at, e.updated_at)
FROM entries e
WHERE e.id = ue.entry_id;
-- That wrote every row anew, scattering each user's rows over twice the
-- pages and into every index, which vacuum doesn't shrink: rewrite both.
CLUSTER user_entries USING user_entry_states_user_id_entry_id_pk;

-- A row's own changes. An insert takes its entry's updated_at too, for a
-- row created after the entry last changed.
CREATE FUNCTION user_entries_changed_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT GREATEST(NEW.updated_at, e.updated_at) INTO NEW.changed_at
      FROM entries e
      WHERE e.id = NEW.entry_id;
  ELSE
    NEW.changed_at := GREATEST(NEW.changed_at, NEW.updated_at);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_entries_changed_at_trigger
  BEFORE INSERT OR UPDATE OF updated_at ON user_entries
  FOR EACH ROW EXECUTE FUNCTION user_entries_changed_at();

-- An entry's content changes, onto every holder's row. A refetch touches one
-- entry, held by at most a few dozen users.
CREATE FUNCTION entries_changed_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE user_entries
  SET changed_at = NEW.updated_at
  WHERE entry_id = NEW.id AND changed_at < NEW.updated_at;
  RETURN NULL;
END;
$$;

CREATE TRIGGER entries_changed_at_trigger
  AFTER UPDATE OF updated_at ON entries
  FOR EACH ROW WHEN (NEW.updated_at > OLD.updated_at)
  EXECUTE FUNCTION entries_changed_at();

-- Sync's keyset, (changed_at, entry_id).
CREATE INDEX idx_user_entries_changed_at ON user_entries (user_id, changed_at, entry_id);

CREATE OR REPLACE VIEW visible_entries AS
 SELECT ue.user_id,
    ue.entry_id AS id,
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
    ue.is_spam,
    e.list_unsubscribe_mailto,
    e.list_unsubscribe_https,
    e.list_unsubscribe_post,
    e.created_at,
    ue.changed_at AS updated_at,
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
    e.search_vector,
    e.updated_at AS entry_updated_at
   FROM user_entries ue
     LEFT JOIN entries e ON e.id = ue.entry_id
  WHERE ue.starred OR ue.active_memberships > 0;
