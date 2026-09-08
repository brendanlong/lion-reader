-- Deduplicate the unread-counter contribution rule (previously written out in
-- each of the three counter trigger functions and mirrored by hand in
-- reconcileCounters). The rule now lives in exactly one place:
-- user_entry_counts_toward_unread / user_entry_counter_contrib, which the
-- triggers and the reconcile sweep all call. Both are LANGUAGE sql IMMUTABLE
-- so the planner inlines them (no per-row function-call overhead, and the
-- boolean form stays usable as a plain predicate).
--
-- Expand-only: new functions + replaced trigger bodies; the trigger
-- declarations and counter semantics are unchanged.

CREATE OR REPLACE FUNCTION public.user_entry_counts_toward_unread(p_read boolean, p_is_spam boolean)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT NOT p_read AND NOT p_is_spam $$;

-- Per-row contribution of a user_entries row to each of the four denormalized
-- counters: subscriptions.unread_count / starred_unread_count (rows attributed
-- to a subscription) and users.saved_unread_count / starred_unread_count
-- (NULL subscription_id = saved article; the user starred counter spans both).
CREATE OR REPLACE FUNCTION public.user_entry_counter_contrib(
  p_read boolean,
  p_starred boolean,
  p_is_spam boolean,
  p_subscription_id uuid
) RETURNS TABLE(
  sub_unread integer,
  sub_starred_unread integer,
  saved_unread integer,
  starred_unread integer
)
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT
    (b.counts AND p_subscription_id IS NOT NULL)::int,
    (b.counts AND p_subscription_id IS NOT NULL AND p_starred)::int,
    (b.counts AND p_subscription_id IS NULL)::int,
    (b.counts AND p_starred)::int
  FROM (SELECT public.user_entry_counts_toward_unread(p_read, p_is_spam) AS counts) b
$$;

CREATE OR REPLACE FUNCTION public.user_entries_counters_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE subscriptions s
  SET unread_count = s.unread_count + d.u,
      starred_unread_count = s.starred_unread_count + d.su
  FROM (
    SELECT n.subscription_id, sum(c.sub_unread)::int AS u, sum(c.sub_starred_unread)::int AS su
    FROM new_rows n,
         LATERAL public.user_entry_counter_contrib(n.read, n.starred, n.is_spam, n.subscription_id) c
    WHERE n.subscription_id IS NOT NULL
    GROUP BY n.subscription_id
    HAVING sum(c.sub_unread) <> 0 OR sum(c.sub_starred_unread) <> 0
  ) d
  WHERE s.id = d.subscription_id;

  UPDATE users usr
  SET saved_unread_count = usr.saved_unread_count + d.sv,
      starred_unread_count = usr.starred_unread_count + d.st
  FROM (
    SELECT n.user_id, sum(c.saved_unread)::int AS sv, sum(c.starred_unread)::int AS st
    FROM new_rows n,
         LATERAL public.user_entry_counter_contrib(n.read, n.starred, n.is_spam, n.subscription_id) c
    GROUP BY n.user_id
    HAVING sum(c.saved_unread) <> 0 OR sum(c.starred_unread) <> 0
  ) d
  WHERE usr.id = d.user_id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.user_entries_counters_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE subscriptions s
  SET unread_count = s.unread_count - d.u,
      starred_unread_count = s.starred_unread_count - d.su
  FROM (
    SELECT o.subscription_id, sum(c.sub_unread)::int AS u, sum(c.sub_starred_unread)::int AS su
    FROM old_rows o,
         LATERAL public.user_entry_counter_contrib(o.read, o.starred, o.is_spam, o.subscription_id) c
    WHERE o.subscription_id IS NOT NULL
    GROUP BY o.subscription_id
    HAVING sum(c.sub_unread) <> 0 OR sum(c.sub_starred_unread) <> 0
  ) d
  WHERE s.id = d.subscription_id;

  UPDATE users usr
  SET saved_unread_count = usr.saved_unread_count - d.sv,
      starred_unread_count = usr.starred_unread_count - d.st
  FROM (
    SELECT o.user_id, sum(c.saved_unread)::int AS sv, sum(c.starred_unread)::int AS st
    FROM old_rows o,
         LATERAL public.user_entry_counter_contrib(o.read, o.starred, o.is_spam, o.subscription_id) c
    GROUP BY o.user_id
    HAVING sum(c.saved_unread) <> 0 OR sum(c.starred_unread) <> 0
  ) d
  WHERE usr.id = d.user_id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.user_entries_counters_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE subscriptions s
  SET unread_count = s.unread_count + d.u,
      starred_unread_count = s.starred_unread_count + d.su
  FROM (
    SELECT subscription_id, sum(u)::int AS u, sum(su)::int AS su
    FROM (
      SELECT n.subscription_id, c.sub_unread AS u, c.sub_starred_unread AS su
      FROM new_rows n,
           LATERAL public.user_entry_counter_contrib(n.read, n.starred, n.is_spam, n.subscription_id) c
      WHERE n.subscription_id IS NOT NULL
      UNION ALL
      SELECT o.subscription_id, -c.sub_unread, -c.sub_starred_unread
      FROM old_rows o,
           LATERAL public.user_entry_counter_contrib(o.read, o.starred, o.is_spam, o.subscription_id) c
      WHERE o.subscription_id IS NOT NULL
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
      SELECT n.user_id, c.saved_unread AS sv, c.starred_unread AS st
      FROM new_rows n,
           LATERAL public.user_entry_counter_contrib(n.read, n.starred, n.is_spam, n.subscription_id) c
      UNION ALL
      SELECT o.user_id, -c.saved_unread, -c.starred_unread
      FROM old_rows o,
           LATERAL public.user_entry_counter_contrib(o.read, o.starred, o.is_spam, o.subscription_id) c
    ) x
    GROUP BY user_id
    HAVING sum(sv) <> 0 OR sum(st) <> 0
  ) d
  WHERE usr.id = d.user_id;
  RETURN NULL;
END;
$$;
