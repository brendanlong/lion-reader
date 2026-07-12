-- Denormalized unread counters, maintained by triggers (issue #1117, step 5a).
--
-- Four counters make every unread badge O(subscriptions) arithmetic instead of
-- an O(unread-entries) scan:
--
--   subscriptions.unread_count          unread, non-spam rows attributed to the sub
--   subscriptions.starred_unread_count  the starred subset of the above
--   users.saved_unread_count            unread rows with no subscription (saved/uploaded)
--   users.starred_unread_count          ALL starred unread rows (any subscription state
--                                       + saved) — the Starred badge directly
--
-- Badge algebra (wired up in step 5b; nothing reads these yet):
--   subscription = s.unread_count
--   tag          = SUM(unread_count) over the tag's active subscriptions
--   saved        = u.saved_unread_count
--   starred      = u.starred_unread_count
--   all          = SUM(unread_count)          over ACTIVE subs
--                + u.saved_unread_count
--                + SUM(starred_unread_count)  over INACTIVE subs   (starred orphans)
--
-- The orphan term derives from which subscriptions are active AT READ TIME, so
-- unsubscribe / resubscribe / feed merges need zero counter writes: rows keep
-- their stamp, dead subs keep accurate (still trigger-maintained) counters, and
-- the re-stamp UPDATE moves counts between subs through the UPDATE trigger.
--
-- SPAM IS PERMANENTLY EXCLUDED from all counters (decided in #1117):
-- user_entries.is_spam is immutable after insert, so contribution never changes
-- out from under a counter.
--
-- Statement-level triggers with transition tables: bulk writes (fanout
-- INSERT...SELECT, mark-all-read, subscribe populate, user-deletion cascades)
-- cost one grouped counter UPDATE per statement, not per row. Rows suppressed
-- by ON CONFLICT DO NOTHING never appear in transition tables; a changedAt-
-- stale replay updates zero rows and produces an empty transition table.
-- Contribution is (NOT read AND NOT is_spam); starred contribution is its
-- starred subset.
--
-- Rollout safety: triggers live in the database, so writes from the previous
-- release maintain the counters during rollout — and keep maintaining them
-- indefinitely after a rollback. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on
-- user_entries until commit, so the backfill below runs with writers blocked
-- and the counters start exact.

ALTER TABLE subscriptions ADD COLUMN unread_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE subscriptions ADD COLUMN starred_unread_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN saved_unread_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN starred_unread_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint

CREATE FUNCTION user_entries_counters_insert() RETURNS trigger AS $$
BEGIN
  UPDATE subscriptions s
  SET unread_count = s.unread_count + d.u,
      starred_unread_count = s.starred_unread_count + d.su
  FROM (
    SELECT subscription_id,
           count(*) FILTER (WHERE NOT read AND NOT is_spam)::int AS u,
           count(*) FILTER (WHERE starred AND NOT read AND NOT is_spam)::int AS su
    FROM new_rows
    WHERE subscription_id IS NOT NULL
    GROUP BY subscription_id
  ) d
  WHERE s.id = d.subscription_id AND (d.u <> 0 OR d.su <> 0);

  UPDATE users usr
  SET saved_unread_count = usr.saved_unread_count + d.sv,
      starred_unread_count = usr.starred_unread_count + d.st
  FROM (
    SELECT user_id,
           count(*) FILTER (WHERE subscription_id IS NULL AND NOT read AND NOT is_spam)::int AS sv,
           count(*) FILTER (WHERE starred AND NOT read AND NOT is_spam)::int AS st
    FROM new_rows
    GROUP BY user_id
  ) d
  WHERE usr.id = d.user_id AND (d.sv <> 0 OR d.st <> 0);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE FUNCTION user_entries_counters_delete() RETURNS trigger AS $$
BEGIN
  UPDATE subscriptions s
  SET unread_count = s.unread_count - d.u,
      starred_unread_count = s.starred_unread_count - d.su
  FROM (
    SELECT subscription_id,
           count(*) FILTER (WHERE NOT read AND NOT is_spam)::int AS u,
           count(*) FILTER (WHERE starred AND NOT read AND NOT is_spam)::int AS su
    FROM old_rows
    WHERE subscription_id IS NOT NULL
    GROUP BY subscription_id
  ) d
  WHERE s.id = d.subscription_id AND (d.u <> 0 OR d.su <> 0);

  UPDATE users usr
  SET saved_unread_count = usr.saved_unread_count - d.sv,
      starred_unread_count = usr.starred_unread_count - d.st
  FROM (
    SELECT user_id,
           count(*) FILTER (WHERE subscription_id IS NULL AND NOT read AND NOT is_spam)::int AS sv,
           count(*) FILTER (WHERE starred AND NOT read AND NOT is_spam)::int AS st
    FROM old_rows
    GROUP BY user_id
  ) d
  WHERE usr.id = d.user_id AND (d.sv <> 0 OR d.st <> 0);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- UPDATE = signed union of new (+) and old (−) contributions. Handles read /
-- starred flips AND subscription_id re-stamps (the merge job) in one shape:
-- a re-stamped row contributes −1 to its old subscription and +1 to its new one.
CREATE FUNCTION user_entries_counters_update() RETURNS trigger AS $$
BEGIN
  UPDATE subscriptions s
  SET unread_count = s.unread_count + d.u,
      starred_unread_count = s.starred_unread_count + d.su
  FROM (
    SELECT subscription_id, sum(u)::int AS u, sum(su)::int AS su
    FROM (
      SELECT subscription_id,
             (NOT read AND NOT is_spam)::int AS u,
             (starred AND NOT read AND NOT is_spam)::int AS su
      FROM new_rows
      WHERE subscription_id IS NOT NULL
      UNION ALL
      SELECT subscription_id,
             -((NOT read AND NOT is_spam)::int),
             -((starred AND NOT read AND NOT is_spam)::int)
      FROM old_rows
      WHERE subscription_id IS NOT NULL
    ) x
    GROUP BY subscription_id
    HAVING sum(u) <> 0 OR sum(su) <> 0
  ) d
  WHERE s.id = d.subscription_id;

  UPDATE users usr
  SET saved_unread_count = usr.saved_unread_count + d.sv,
      starred_unread_count = usr.starred_unread_count + d.st
  FROM (
    SELECT user_id, sum(sv)::int AS sv, sum(st)::int AS st
    FROM (
      SELECT user_id,
             (subscription_id IS NULL AND NOT read AND NOT is_spam)::int AS sv,
             (starred AND NOT read AND NOT is_spam)::int AS st
      FROM new_rows
      UNION ALL
      SELECT user_id,
             -((subscription_id IS NULL AND NOT read AND NOT is_spam)::int),
             -((starred AND NOT read AND NOT is_spam)::int)
      FROM old_rows
    ) x
    GROUP BY user_id
    HAVING sum(sv) <> 0 OR sum(st) <> 0
  ) d
  WHERE usr.id = d.user_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER user_entries_counters_insert_trigger
  AFTER INSERT ON user_entries
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION user_entries_counters_insert();
--> statement-breakpoint
CREATE TRIGGER user_entries_counters_update_trigger
  AFTER UPDATE ON user_entries
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION user_entries_counters_update();
--> statement-breakpoint
CREATE TRIGGER user_entries_counters_delete_trigger
  AFTER DELETE ON user_entries
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION user_entries_counters_delete();
--> statement-breakpoint

-- Backfill. Writers are blocked (trigger creation locks above), so these
-- snapshots are exact at commit. Rows with no unread entries keep the 0 default.
UPDATE subscriptions s
SET unread_count = c.u,
    starred_unread_count = c.su
FROM (
  SELECT subscription_id,
         count(*)::int AS u,
         count(*) FILTER (WHERE starred)::int AS su
  FROM user_entries
  WHERE subscription_id IS NOT NULL AND NOT read AND NOT is_spam
  GROUP BY subscription_id
) c
WHERE s.id = c.subscription_id;
--> statement-breakpoint
UPDATE users u
SET saved_unread_count = c.sv,
    starred_unread_count = c.st
FROM (
  SELECT user_id,
         count(*) FILTER (WHERE subscription_id IS NULL)::int AS sv,
         count(*) FILTER (WHERE starred)::int AS st
  FROM user_entries
  WHERE NOT read AND NOT is_spam
  GROUP BY user_id
) c
WHERE u.id = c.user_id;
--> statement-breakpoint

-- Register the reconcile_counters singleton job (self-healing sweep that
-- recomputes counters from user_entries and fixes + reports any drift).
DROP INDEX jobs_singleton_type_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX jobs_singleton_type_unique ON jobs (type)
  WHERE type IN ('renew_websub', 'monitor_feed_health', 'cleanup', 'reconcile_counters');
