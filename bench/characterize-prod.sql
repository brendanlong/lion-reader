-- Lion Reader — production usage characterization (READ ONLY)
--
-- Purpose: derive the real per-user parameters that drive the load-test
-- workload + seed generator (bench/). Every statement is a SELECT; nothing is
-- written. Safe to run against production.
--
-- How to run (you have the Fly perms; the agent's token cannot build a tunnel):
--   flyctl mpg proxy k1v53olme1nr8q6p --local-port 16987      # in one shell
--   psql "postgres://<user>:<pass>@127.0.0.1:16987/<db>" \
--        -v ON_ERROR_STOP=1 -f bench/characterize-prod.sql -o bench/prod-stats.txt
-- (get the URL from `flyctl mpg connect k1v53olme1nr8q6p --help` / the cluster
--  credentials, or just run `flyctl mpg connect k1v53olme1nr8q6p` and `\i` this file)
--
-- Then paste bench/prod-stats.txt back to me. Runtime is a few seconds; the
-- heaviest queries scan user_entries once (small for this app).

\pset pager off
\timing on

-- Belt-and-suspenders: refuse to write even if something unexpected happens.
SET default_transaction_read_only = on;

\echo '==================== 1. TOTALS ===================='
SELECT
  (SELECT count(*) FROM users)                                              AS users_total,
  (SELECT count(*) FROM subscriptions WHERE unsubscribed_at IS NULL)        AS active_subscriptions,
  (SELECT count(*) FROM feeds)                                              AS feeds_total,
  (SELECT count(*) FROM entries)                                            AS entries_total,
  (SELECT count(*) FROM user_entries)                                       AS user_entries_total,
  (SELECT count(*) FROM sessions WHERE revoked_at IS NULL
                                   AND expires_at > now())                  AS live_sessions;

\echo '==================== 2. ACTIVE USERS (recency) ===================='
-- The registered->concurrent translation hinges on these windows.
SELECT
  count(*) FILTER (WHERE last_active_at > now() - interval '5 minutes')  AS active_5m,
  count(*) FILTER (WHERE last_active_at > now() - interval '1 hour')     AS active_1h,
  count(*) FILTER (WHERE last_active_at > now() - interval '1 day')      AS active_1d,
  count(*) FILTER (WHERE last_active_at > now() - interval '7 days')     AS active_7d,
  count(*) FILTER (WHERE last_active_at > now() - interval '30 days')    AS active_30d,
  count(*) FILTER (WHERE last_active_at IS NULL)                         AS never_active
FROM users;

\echo '==================== 3. SUBSCRIPTIONS PER USER (distribution) ===================='
WITH per_user AS (
  SELECT user_id, count(*) AS subs
  FROM subscriptions
  WHERE unsubscribed_at IS NULL
  GROUP BY user_id
)
SELECT
  count(*)                                                    AS users_with_subs,
  round(avg(subs), 1)                                         AS mean_subs,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY subs)          AS p50_subs,
  percentile_cont(0.9)  WITHIN GROUP (ORDER BY subs)          AS p90_subs,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY subs)          AS p99_subs,
  max(subs)                                                   AS max_subs
FROM per_user;

\echo '==================== 4. UNREAD PER SUBSCRIPTION (distribution) ===================='
SELECT
  round(avg(unread_count), 1)                                       AS mean_unread,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY unread_count)         AS p50_unread,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY unread_count)         AS p90_unread,
  max(unread_count)                                                 AS max_unread
FROM subscriptions
WHERE unsubscribed_at IS NULL;

\echo '==================== 5. ENTRIES PER USER + READ/STAR RATES ===================='
WITH per_user AS (
  SELECT
    user_id,
    count(*)                                    AS entries,
    count(*) FILTER (WHERE read)                AS read_entries,
    count(*) FILTER (WHERE starred)             AS starred_entries
  FROM user_entries
  GROUP BY user_id
)
SELECT
  round(avg(entries), 0)                                        AS mean_entries_per_user,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY entries)         AS p50_entries,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY entries)         AS p90_entries,
  max(entries)                                                 AS max_entries_per_user,
  round(100.0 * sum(read_entries)    / NULLIF(sum(entries),0), 1) AS pct_read,
  round(100.0 * sum(starred_entries) / NULLIF(sum(entries),0), 2) AS pct_starred
FROM per_user;

\echo '==================== 6. ENTRY INFLOW (new entries / day) ===================='
SELECT
  count(*) FILTER (WHERE fetched_at > now() - interval '1 day')   AS entries_last_1d,
  round(count(*) FILTER (WHERE fetched_at > now() - interval '7 days') / 7.0, 1)   AS entries_per_day_7d_avg,
  round(count(*) FILTER (WHERE fetched_at > now() - interval '30 days') / 30.0, 1) AS entries_per_day_30d_avg
FROM entries;

\echo '==================== 7. FEEDS BY TYPE + POLL CADENCE ===================='
SELECT type, count(*) AS feeds FROM feeds GROUP BY type ORDER BY feeds DESC;

-- Effective poll interval currently scheduled (next_fetch_at - last_fetched_at).
SELECT
  count(*) FILTER (WHERE next_fetch_at IS NOT NULL)                                    AS feeds_scheduled,
  round(avg(EXTRACT(EPOCH FROM (next_fetch_at - last_fetched_at)))/60.0, 1)            AS mean_interval_min,
  round(percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (next_fetch_at - last_fetched_at)))/60.0, 1)     AS p50_interval_min,
  round(percentile_cont(0.9) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (next_fetch_at - last_fetched_at)))/60.0, 1)     AS p90_interval_min
FROM feeds
WHERE last_fetched_at IS NOT NULL AND next_fetch_at IS NOT NULL;

-- How many feed fetches actually happen per hour right now (worker load proxy):
SELECT
  count(*) FILTER (WHERE last_fetched_at > now() - interval '1 hour')  AS fetches_last_1h,
  count(*) FILTER (WHERE last_fetched_at > now() - interval '1 day')   AS fetches_last_1d
FROM feeds;

\echo '==================== 8. SESSIONS PER USER ===================='
WITH per_user AS (
  SELECT user_id, count(*) AS sessions
  FROM sessions
  WHERE revoked_at IS NULL AND expires_at > now()
  GROUP BY user_id
)
SELECT
  count(*)                                                       AS users_with_live_session,
  round(avg(sessions), 1)                                        AS mean_live_sessions,
  max(sessions)                                                  AS max_live_sessions
FROM per_user;

\echo '==================== 9. TABLE SIZES (DB footprint) ===================='
SELECT
  relname AS table_name,
  n_live_tup AS est_rows,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 12;

\echo '==================== DONE ===================='
