-- Two more list orders (#2064): a per-user score (how much the user wants an
-- article; an AI assistant sets it over MCP) and a per-collection position
-- (an article's place in one collection, e.g. a chapter). Both are plain
-- numbers, NULL for "none". user_entries.score is authoritative; memberships
-- and tag rows carry copies, kept by the same triggers as their read and
-- starred (migrations 0165, 0167), so each list's index can sort by it.
-- Positions live on the membership alone. The indexes are in 0169.
SET LOCAL lock_timeout = '5s';

-- All three exclusively, up front and in the lock order (src/server/CLAUDE.md):
-- altering user_entries needs its exclusive lock, and upgrading to it after
-- the others deadlocks with a list read holding user_entries and waiting on
-- them. Adding nullable columns without a default rewrites nothing, so the
-- locks are brief, and every existing row's copy (NULL) is already right.
LOCK TABLE user_entries, subscription_entries, tag_entries IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE user_entries ADD COLUMN score double precision;
--> statement-breakpoint
ALTER TABLE subscription_entries
  ADD COLUMN score double precision,
  ADD COLUMN position double precision;
--> statement-breakpoint
ALTER TABLE tag_entries ADD COLUMN score double precision;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subscription_entries_copy_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
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
    SET read = ue.read, starred = ue.starred, is_spam = ue.is_spam, score = ue.score
    FROM changed_rows c
    JOIN user_entries ue ON ue.user_id = c.user_id AND ue.entry_id = c.entry_id
    WHERE se.subscription_id = c.subscription_id AND se.entry_id = c.entry_id
      AND (se.read, se.starred, se.is_spam, se.score)
        IS DISTINCT FROM (ue.read, ue.starred, ue.is_spam, ue.score)
  $q$;

  EXECUTE $q$
    SELECT 1 FROM subscriptions
    WHERE id IN (SELECT DISTINCT subscription_id FROM changed_rows)
    ORDER BY id FOR NO KEY UPDATE
  $q$;

  SELECT array_agg(user_id), array_agg(entry_id) INTO v_user, v_entry FROM changed_rows;
  PERFORM add_reached_tag_entries(v_user, v_entry, true);
  RETURN NULL;
END;
$_$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION user_entries_copy_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
BEGIN
  EXECUTE $q$
    UPDATE subscription_entries se
    SET read = n.read, starred = n.starred, is_spam = n.is_spam, score = n.score
    FROM (
      SELECT user_id, entry_id, read, starred, is_spam, score FROM new_rows
      EXCEPT
      SELECT user_id, entry_id, read, starred, is_spam, score FROM old_rows
    ) n
    WHERE se.user_id = n.user_id AND se.entry_id = n.entry_id
      AND (se.read, se.starred, se.is_spam, se.score)
        IS DISTINCT FROM (n.read, n.starred, n.is_spam, n.score)
  $q$;

  EXECUTE $q$
    UPDATE tag_entries te
    SET read = n.read, starred = n.starred, score = n.score
    FROM (
      SELECT user_id, entry_id, read, starred, score FROM new_rows
      EXCEPT
      SELECT user_id, entry_id, read, starred, score FROM old_rows
    ) n
    WHERE te.user_id = n.user_id AND te.entry_id = n.entry_id
      AND (te.read, te.starred, te.score) IS DISTINCT FROM (n.read, n.starred, n.score)
  $q$;
  RETURN NULL;
END;
$_$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION add_reached_tag_entries(p_user uuid[], p_entry uuid[], p_locked boolean)
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

  INSERT INTO tag_entries (user_id, entry_id, list_id, published_or_fetched_at, read, starred, score)
  SELECT r.user_id, r.entry_id, r.list_id, ue.published_or_fetched_at, ue.read, ue.starred, ue.score
  FROM reached_tag_lists(p_user, p_entry) r
  JOIN user_entries ue ON ue.user_id = r.user_id AND ue.entry_id = r.entry_id
  ORDER BY r.user_id, r.entry_id, r.list_id
  ON CONFLICT DO NOTHING;
END;
$$;
--> statement-breakpoint
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
    e.updated_at AS entry_updated_at,
    ue.score
   FROM user_entries ue
     LEFT JOIN entries e ON e.id = ue.entry_id
  WHERE ue.starred OR ue.active_memberships > 0;
