-- EXPLAIN (ANALYZE, BUFFERS) for every Postgres query issued during SSR of the
-- entries-list page and the entry-open page. Run against the seeded DB.
--
-- Reconstructs each service query faithfully (see the mapping in the report).
-- Queries that read only the session (auth.me, users.me.preferences,
-- summarization.isAvailable) issue no SQL and are omitted.

\set U0 '01890000-0000-7000-8000-000000000001'
\set QUIET 1
\pset pager off
\set ECHO none

-- Resolve representative ids for the parameterized queries.
SELECT id AS sub_id FROM subscriptions
  WHERE user_id = :'U0' AND unsubscribed_at IS NULL
  ORDER BY unread_count DESC LIMIT 1
\gset
SELECT id AS tag_id FROM tags WHERE user_id = :'U0' ORDER BY name LIMIT 1
\gset
SELECT id AS entry_id FROM visible_entries
  WHERE user_id = :'U0' AND type = 'web' ORDER BY published_or_fetched_at DESC LIMIT 1
\gset
-- A cursor position ~page 20 into the /all unread timeline, to benchmark keyset
-- pagination (a deep page, not the first).
SELECT published_or_fetched_at AS cur_ts, id AS cur_id
  FROM visible_entries
  WHERE user_id = :'U0' AND read = false AND is_spam = false
  ORDER BY published_or_fetched_at DESC, id DESC
  OFFSET 200 LIMIT 1
\gset

\set ECHO queries
\timing on

------------------------------------------------------------------------------
-- tags.list  (sidebar tags + counts) — 3 queries
------------------------------------------------------------------------------

-- Q: tags with feed_count (inline subquery) + unread_count (left join sum)
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT tags.id, tags.name, tags.color, tags.created_at,
  (SELECT COUNT(*)::int FROM subscription_tags WHERE subscription_tags.tag_id = tags.id) AS feed_count,
  COALESCE(tuc.unread_count, 0) AS unread_count
FROM tags
LEFT JOIN (
  SELECT st.tag_id, sum(s.unread_count)::int AS unread_count
  FROM subscription_tags st
  JOIN subscriptions s ON s.id = st.subscription_id AND s.user_id = :'U0' AND s.unsubscribed_at IS NULL
  GROUP BY st.tag_id
) tuc ON tuc.tag_id = tags.id
WHERE tags.user_id = :'U0' AND tags.deleted_at IS NULL
ORDER BY tags.name;

-- Q: uncategorized feed count (active untagged subscriptions)
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT COUNT(*)::int
FROM subscriptions
WHERE user_id = :'U0' AND unsubscribed_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM subscription_tags st WHERE st.subscription_id = subscriptions.id);

-- Q: uncategorized unread (SUM of unread_count over active untagged subs)
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT COALESCE(sum(unread_count), 0)::int
FROM subscriptions
WHERE user_id = :'U0' AND unsubscribed_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM subscription_tags st WHERE st.subscription_id = subscriptions.id);

------------------------------------------------------------------------------
-- entries.count  (all / saved / starred badges) — counter fast path.
-- getGlobalUnreadCounts: identical query for all three prefetches.
------------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT (COALESCE(sum(s.unread_count) FILTER (WHERE s.unsubscribed_at IS NULL), 0)
        + u.saved_unread_count
        + COALESCE(sum(s.starred_unread_count) FILTER (WHERE s.unsubscribed_at IS NOT NULL), 0))::int AS all_unread,
       u.starred_unread_count, u.saved_unread_count
FROM users u
LEFT JOIN subscriptions s ON s.user_id = u.id
WHERE u.id = :'U0'
GROUP BY u.id, u.saved_unread_count, u.starred_unread_count;

------------------------------------------------------------------------------
-- sync.cursors  (initial SSE cursors — AWAITED, so blocks SSR) — 3 queries
------------------------------------------------------------------------------

-- Q: newest GREATEST(entries.updated_at, user_entries.updated_at) + its id.
--    Sort key spans two tables, so no single index covers it.
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT GREATEST(e.updated_at, ue.updated_at) AS max, e.id
FROM user_entries ue
JOIN entries e ON e.id = ue.entry_id
WHERE ue.user_id = :'U0'
ORDER BY GREATEST(e.updated_at, ue.updated_at) DESC, e.id DESC
LIMIT 1;

-- Q: max subscription updated_at
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT MAX(updated_at) FROM subscriptions WHERE user_id = :'U0';

-- Q: max tag updated_at
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT MAX(updated_at) FROM tags WHERE user_id = :'U0';

------------------------------------------------------------------------------
-- entries.list  (the timeline) — one per route. limit 10 -> fetch 11.
-- Default unreadOnly=true for every route except /recently-read.
------------------------------------------------------------------------------

-- /all  (unread, newest) — first page
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT ve.id, ve.greader_item_id, ve.subscription_greader_stream_id, feeds.greader_stream_id,
       ve.feed_id, ve.type, ve.url, ve.title, ve.author, ve.summary, ve.published_at,
       ve.fetched_at, ve.read, ve.starred, ve.updated_at, ve.subscription_id, ve.site_name,
       feeds.title AS feed_title, ve.read_changed_at, ve.published_or_fetched_at
FROM visible_entries ve
JOIN feeds ON feeds.id = ve.feed_id
WHERE ve.user_id = :'U0' AND ve.read = false AND ve.is_spam = false
ORDER BY ve.published_or_fetched_at DESC, ve.id DESC
LIMIT 11;

-- /all  page ~20 (keyset cursor) — deep page
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT ve.id, ve.published_or_fetched_at
FROM visible_entries ve
JOIN feeds ON feeds.id = ve.feed_id
WHERE ve.user_id = :'U0' AND ve.read = false AND ve.is_spam = false
  AND (ve.published_or_fetched_at < :'cur_ts'::timestamptz
       OR (ve.published_or_fetched_at = :'cur_ts'::timestamptz AND ve.id < :'cur_id'))
ORDER BY ve.published_or_fetched_at DESC, ve.id DESC
LIMIT 11;

-- /subscription/:id  (unread)
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT ve.id, ve.published_or_fetched_at, feeds.title
FROM visible_entries ve
JOIN feeds ON feeds.id = ve.feed_id
WHERE ve.user_id = :'U0' AND ve.subscription_id IN (:'sub_id')
  AND ve.read = false AND ve.is_spam = false
ORDER BY ve.published_or_fetched_at DESC, ve.id DESC
LIMIT 11;

-- /tag/:tagId  (unread; subscription_id IN tagged-subs subquery)
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT ve.id, ve.published_or_fetched_at
FROM visible_entries ve
JOIN feeds ON feeds.id = ve.feed_id
WHERE ve.user_id = :'U0'
  AND ve.subscription_id IN (
    SELECT st.subscription_id FROM subscription_tags st
    JOIN tags t ON t.id = st.tag_id AND t.user_id = :'U0' AND t.deleted_at IS NULL
    WHERE st.tag_id = :'tag_id')
  AND ve.read = false AND ve.is_spam = false
ORDER BY ve.published_or_fetched_at DESC, ve.id DESC
LIMIT 11;

-- /starred  (unread starred, newest)
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT ve.id, ve.published_or_fetched_at
FROM visible_entries ve
JOIN feeds ON feeds.id = ve.feed_id
WHERE ve.user_id = :'U0' AND ve.starred = true AND ve.read = false AND ve.is_spam = false
ORDER BY ve.published_or_fetched_at DESC, ve.id DESC
LIMIT 11;

-- /saved  (unread saved articles)
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT ve.id, ve.published_or_fetched_at
FROM visible_entries ve
JOIN feeds ON feeds.id = ve.feed_id
WHERE ve.user_id = :'U0' AND ve.type = 'saved' AND ve.read = false AND ve.is_spam = false
ORDER BY ve.published_or_fetched_at DESC, ve.id DESC
LIMIT 11;

-- /uncategorized  (unread; subscription_id IN uncategorized-subs subquery)
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT ve.id, ve.published_or_fetched_at
FROM visible_entries ve
JOIN feeds ON feeds.id = ve.feed_id
WHERE ve.user_id = :'U0'
  AND ve.subscription_id IN (
    SELECT s.id FROM subscriptions s
    LEFT JOIN subscription_tags st ON st.subscription_id = s.id
    WHERE s.user_id = :'U0' AND s.unsubscribed_at IS NULL AND st.subscription_id IS NULL)
  AND ve.read = false AND ve.is_spam = false
ORDER BY ve.published_or_fetched_at DESC, ve.id DESC
LIMIT 11;

-- /recently-read  (unreadOnly=false, sortBy=readChanged; read_changed_at NOT NULL)
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT ve.id, ve.read_changed_at
FROM visible_entries ve
JOIN feeds ON feeds.id = ve.feed_id
WHERE ve.user_id = :'U0' AND ve.is_spam = false AND ve.read_changed_at IS NOT NULL
ORDER BY ve.read_changed_at DESC, ve.id DESC
LIMIT 11;

------------------------------------------------------------------------------
-- entries.get  (full entry, entry-open page). selectFullEntry.
------------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT ve.id, ve.greader_item_id, ve.subscription_greader_stream_id, feeds.greader_stream_id,
       ve.feed_id, ve.type, ve.url, ve.title, ve.author,
       ve.content_original_sanitized, ve.content_cleaned_sanitized, ve.content_sanitized_version,
       (ve.content_original IS NOT NULL OR ve.content_cleaned IS NOT NULL) AS has_content_raw,
       ve.summary, ve.published_at, ve.fetched_at, ve.read, ve.starred, ve.updated_at,
       ve.subscription_id, ve.site_name, feeds.title, feeds.url, ve.unsubscribe_url,
       ve.full_content_original_sanitized, ve.full_content_cleaned_sanitized,
       ve.full_content_sanitized_version, ve.full_content_fetched_at, ve.full_content_error,
       ve.content_hash, s.fetch_full_content
FROM visible_entries ve
JOIN feeds ON feeds.id = ve.feed_id
LEFT JOIN subscriptions s ON s.id = ve.subscription_id
WHERE ve.id = :'entry_id' AND ve.user_id = :'U0'
LIMIT 1;

------------------------------------------------------------------------------
-- subscriptions.get  (subscription pages only). getSubscription via user_feeds.
------------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS, COSTS off, SUMMARY off)
SELECT uf.id, uf.subscribed_at, uf.feed_id, uf.fetch_full_content, uf.type, uf.url, uf.title,
       uf.original_title, uf.description, uf.site_url, uf.unread_count,
       COALESCE(json_agg(json_build_object('id', tags.id, 'name', tags.name, 'color', tags.color))
                FILTER (WHERE tags.id IS NOT NULL), '[]'::json) AS tags
FROM user_feeds uf
LEFT JOIN subscription_tags ON subscription_tags.subscription_id = uf.id
LEFT JOIN tags ON tags.id = subscription_tags.tag_id
WHERE uf.id = :'sub_id' AND uf.user_id = :'U0'
GROUP BY uf.id, uf.subscribed_at, uf.feed_id, uf.fetch_full_content, uf.type, uf.url, uf.title,
         uf.original_title, uf.description, uf.site_url, uf.unread_count;
