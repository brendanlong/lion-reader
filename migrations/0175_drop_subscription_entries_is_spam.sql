-- Memberships no longer copy is_spam (#2114): no index excludes spam any
-- more, and lists filter it on the joined user_entries row, where it never
-- changes. The previous release neither reads nor writes the copy.
SET LOCAL lock_timeout = '5s';

-- Spam articles get tag and Uncategorized rows too (0176 backfills them).
CREATE OR REPLACE FUNCTION reached_tag_lists(p_user uuid[], p_entry uuid[])
    RETURNS TABLE (list_id uuid, user_id uuid, entry_id uuid)
    LANGUAGE sql STABLE
    AS $$
  SELECT DISTINCT COALESCE(t.id, se.user_id), se.user_id, se.entry_id
  FROM (SELECT DISTINCT u, e FROM unnest(p_user, p_entry) AS p(u, e)) p
  JOIN subscription_entries se ON se.user_id = p.u AND se.entry_id = p.e
  JOIN subscriptions s ON s.id = se.subscription_id AND s.unsubscribed_at IS NULL
  LEFT JOIN subscription_tags st ON st.subscription_id = s.id
  LEFT JOIN tags t ON t.id = st.tag_id AND t.user_id = s.user_id AND t.deleted_at IS NULL
  WHERE t.id IS NOT NULL OR (st.subscription_id IS NULL AND s.type <> 'saved')
$$;
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
    SET read = ue.read, starred = ue.starred, score = ue.score
    FROM changed_rows c
    JOIN user_entries ue ON ue.user_id = c.user_id AND ue.entry_id = c.entry_id
    WHERE se.subscription_id = c.subscription_id AND se.entry_id = c.entry_id
      AND (se.read, se.starred, se.score) IS DISTINCT FROM (ue.read, ue.starred, ue.score)
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
    SET read = n.read, starred = n.starred, score = n.score
    FROM (
      SELECT user_id, entry_id, read, starred, score FROM new_rows
      EXCEPT
      SELECT user_id, entry_id, read, starred, score FROM old_rows
    ) n
    WHERE se.user_id = n.user_id AND se.entry_id = n.entry_id
      AND (se.read, se.starred, se.score) IS DISTINCT FROM (n.read, n.starred, n.score)
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
ALTER TABLE subscription_entries DROP COLUMN IF EXISTS is_spam;
