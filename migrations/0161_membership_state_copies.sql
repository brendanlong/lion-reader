-- Memberships carry copies of their user_entries row's read, starred and
-- is_spam (#2066), so one subscription's unread page reads an index of its
-- unread memberships instead of walking all of them and probing user_entries.
-- Triggers keep the copies; app code never writes them.
SET LOCAL lock_timeout = '5s';

-- Up front, in the lock order (src/server/CLAUDE.md), so a write already
-- holding one of these can't deadlock with the migration.
LOCK TABLE user_entries IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE subscription_entries IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint

-- Existing rows take each column's first default without a rewrite. Most are
-- read, so `read` starts true for them and the backfill (0162, in its own
-- transaction so this one's exclusive lock is brief) touches only the unread,
-- starred and spam ones; new rows default to false.
ALTER TABLE subscription_entries
  ADD COLUMN read boolean NOT NULL DEFAULT true,
  ADD COLUMN starred boolean NOT NULL DEFAULT false,
  ADD COLUMN is_spam boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE subscription_entries ALTER COLUMN read SET DEFAULT false;
--> statement-breakpoint
-- A new membership takes its row's state. The rows are locked in key order
-- (NO KEY UPDATE, not SHARE: the counter trigger may then update them, and
-- two share lockers upgrading deadlock), so a read or star committing
-- meanwhile either comes first and is copied, or waits and then reaches the
-- new membership through user_entries_copy_state. This fires before the
-- counter trigger (triggers fire in name order), keeping user_entries ahead of
-- subscriptions in the lock order.
--
-- These trigger functions EXECUTE their statements: a static one keeps the
-- plan of the connection's first call, sized for its transition table, and a
-- plan for one row turns quadratic on thousands.
CREATE FUNCTION subscription_entries_copy_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
    SET read = ue.read, starred = ue.starred, is_spam = ue.is_spam
    FROM changed_rows c
    JOIN user_entries ue ON ue.user_id = c.user_id AND ue.entry_id = c.entry_id
    WHERE se.subscription_id = c.subscription_id AND se.entry_id = c.entry_id
      AND (se.read, se.starred, se.is_spam) IS DISTINCT FROM (ue.read, ue.starred, ue.is_spam)
  $q$;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER subscription_entries_copy_state_trigger
  AFTER INSERT ON subscription_entries
  REFERENCING NEW TABLE AS changed_rows
  FOR EACH STATEMENT EXECUTE FUNCTION subscription_entries_copy_state();
--> statement-breakpoint
-- A read or star change reaches the row's memberships. The statement holds the
-- user_entries rows, so it locks memberships after them, and this fires before
-- the counter trigger locks subscriptions and users. EXCEPT finds the changed
-- rows by hashing or sorting, never a nested loop over the transition tables.
CREATE FUNCTION user_entries_copy_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  EXECUTE $q$
    UPDATE subscription_entries se
    SET read = n.read, starred = n.starred, is_spam = n.is_spam
    FROM (
      SELECT user_id, entry_id, read, starred, is_spam FROM new_rows
      EXCEPT
      SELECT user_id, entry_id, read, starred, is_spam FROM old_rows
    ) n
    WHERE se.user_id = n.user_id AND se.entry_id = n.entry_id
      AND (se.read, se.starred, se.is_spam) IS DISTINCT FROM (n.read, n.starred, n.is_spam)
  $q$;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_entries_copy_state_trigger
  AFTER UPDATE ON user_entries
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION user_entries_copy_state();
