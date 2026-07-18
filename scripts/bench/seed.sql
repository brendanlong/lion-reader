-- Realistic seed for SSR query benchmarking.
--
-- Builds a mid-size deployment with a heavy "target" user (U0) whose library is
-- what the SSR queries are benchmarked against, plus enough noise (other users,
-- shared feeds, entries) that the shared tables are large and the planner's
-- index choices are realistic. All counters are trigger-maintained by the bulk
-- inserts, matching production.
--
-- Target user U0: 01890000-0000-7000-8000-000000000001
--
-- Tunables (rough): ~4000 web feeds, ~350k web entries, target user subscribed
-- to 300 feeds (~25k user_entries) + 200 saved articles, 30 tags, 60 noise users.

\set U0 '01890000-0000-7000-8000-000000000001'
\set SAVED_FEED '01890000-0000-7000-8000-0000000000ff'
\set SANVER 10

\timing on

-- Reset (idempotent re-seed).
TRUNCATE users, feeds, entries, subscriptions, user_entries, tags, subscription_tags
  RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
INSERT INTO users (id, email) VALUES (:'U0', 'bench@example.com');

INSERT INTO users (id, email)
SELECT gen_random_uuid(), 'noise' || g || '@example.com'
FROM generate_series(1, 60) g;

-- ---------------------------------------------------------------------------
-- Web feeds (global; shared across subscribers) with a per-feed entry count
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE tmp_feed(id uuid, n int);
INSERT INTO tmp_feed
SELECT gen_random_uuid(), (20 + floor(random() * 280))::int
FROM generate_series(1, 4000);

INSERT INTO feeds (id, type, url, title, site_url, next_fetch_at)
SELECT id, 'web',
       'https://feed-' || row_number() OVER () || '.example.com/rss',
       'Feed ' || row_number() OVER (),
       'https://feed-' || row_number() OVER () || '.example.com',
       now()
FROM tmp_feed;

-- ---------------------------------------------------------------------------
-- Web entries: for each feed, `n` entries spread over the last ~2 years.
-- Sanitized columns are pre-populated at the current SANITIZER_VERSION so the
-- full-entry read path is a pure read (no self-heal), matching steady state.
-- ---------------------------------------------------------------------------
INSERT INTO entries (
  id, feed_id, guid, url, title, author,
  content_original, content_cleaned,
  content_original_sanitized, content_cleaned_sanitized, content_sanitized_version,
  summary, published_at, fetched_at, last_seen_at, content_hash, type
)
SELECT
  gen_random_uuid(), tf.id,
  'guid-' || tf.id || '-' || g,
  'https://feed.example.com/' || tf.id || '/' || g,
  'Entry ' || g || ' for feed ' || tf.id,
  'Author ' || (g % 7),
  repeat('lorem ipsum dolor sit amet ', 40),
  repeat('lorem ipsum dolor sit amet ', 30),
  repeat('lorem ipsum dolor sit amet ', 30),
  repeat('lorem ipsum dolor sit amet ', 30),
  :SANVER,
  'Summary for entry ' || g,
  ts.published_at, ts.published_at, ts.published_at,
  md5(random()::text), 'web'
FROM tmp_feed tf
CROSS JOIN LATERAL generate_series(1, tf.n) g
CROSS JOIN LATERAL (
  SELECT now() - ((random() * 730)::int || ' days')::interval
                - ((random() * 24)::int || ' hours')::interval AS published_at
) ts;

-- ---------------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------------
-- Target user: 300 random web feeds.
INSERT INTO subscriptions (id, user_id, feed_id, subscribed_at)
SELECT gen_random_uuid(), :'U0', id, now()
FROM (SELECT id FROM feeds WHERE type = 'web' ORDER BY random() LIMIT 300) x;

-- Noise users: ~25 random web feeds each.
INSERT INTO subscriptions (id, user_id, feed_id, subscribed_at)
SELECT gen_random_uuid(), u.id, f.id, now()
FROM users u
CROSS JOIN LATERAL (
  SELECT id FROM feeds WHERE type = 'web' ORDER BY random() LIMIT 25
) f
WHERE u.email LIKE 'noise%@example.com';

-- ---------------------------------------------------------------------------
-- user_entries: one row per (user, entry) for every entry in a subscribed feed.
-- ~85% read, ~3% starred. Counter triggers fire on these statements.
-- ---------------------------------------------------------------------------
-- Target user (kept a separate statement so its counters settle independently).
INSERT INTO user_entries (
  user_id, entry_id, read, starred, subscription_id, is_spam,
  published_or_fetched_at, read_changed_at, updated_at, created_at, starred_changed_at
)
SELECT
  s.user_id, e.id,
  (abs(hashtext(e.id::text || s.id::text)) % 100) >= 15,   -- 85% read
  (abs(hashtext(e.id::text)) % 100) < 3,                   -- 3% starred
  s.id, false,
  COALESCE(e.published_at, e.fetched_at),
  CASE WHEN (abs(hashtext(e.id::text || s.id::text)) % 100) >= 15
       THEN now() - ((abs(hashtext(e.id::text)) % 400) || ' hours')::interval
       ELSE NULL END,
  now(), now(), now()
FROM subscriptions s
JOIN entries e ON e.feed_id = s.feed_id
WHERE s.user_id = :'U0';

-- Noise users.
INSERT INTO user_entries (
  user_id, entry_id, read, starred, subscription_id, is_spam,
  published_or_fetched_at, read_changed_at, updated_at, created_at, starred_changed_at
)
SELECT
  s.user_id, e.id,
  (abs(hashtext(e.id::text || s.id::text)) % 100) >= 15,
  (abs(hashtext(e.id::text)) % 100) < 3,
  s.id, false,
  COALESCE(e.published_at, e.fetched_at),
  CASE WHEN (abs(hashtext(e.id::text || s.id::text)) % 100) >= 15
       THEN now() - ((abs(hashtext(e.id::text)) % 400) || ' hours')::interval
       ELSE NULL END,
  now(), now(), now()
FROM subscriptions s
JOIN entries e ON e.feed_id = s.feed_id
WHERE s.user_id <> :'U0';

-- ---------------------------------------------------------------------------
-- Tags + tagging (target user): 30 tags, ~70% of subs tagged with 1-2 tags.
-- ---------------------------------------------------------------------------
INSERT INTO tags (id, user_id, name)
SELECT gen_random_uuid(), :'U0', 'Tag ' || g
FROM generate_series(1, 30) g;

INSERT INTO subscription_tags (subscription_id, tag_id)
SELECT s.id, t.id
FROM subscriptions s
JOIN LATERAL (
  SELECT id FROM tags WHERE user_id = :'U0'
  ORDER BY random() LIMIT (1 + floor(random() * 2))::int
) t ON true
WHERE s.user_id = :'U0' AND random() < 0.7;

-- ---------------------------------------------------------------------------
-- Saved articles (target user): own saved feed + 200 saved entries.
-- ---------------------------------------------------------------------------
INSERT INTO feeds (id, type, user_id, title) VALUES (:'SAVED_FEED', 'saved', :'U0', 'Saved');

INSERT INTO entries (
  id, feed_id, guid, url, title,
  content_cleaned, content_cleaned_sanitized, content_sanitized_version,
  summary, published_at, fetched_at, content_hash, type, site_name
)
SELECT
  gen_random_uuid(), :'SAVED_FEED', 'saved-' || g,
  'https://saved.example.com/' || g, 'Saved article ' || g,
  repeat('saved body text ', 50), repeat('saved body text ', 50), :SANVER,
  'Saved summary ' || g,
  now() - (g || ' days')::interval, now() - (g || ' days')::interval,
  md5(random()::text), 'saved', 'saved.example.com'
FROM generate_series(1, 200) g;

INSERT INTO user_entries (
  user_id, entry_id, read, starred, subscription_id, is_spam,
  published_or_fetched_at, updated_at, created_at, starred_changed_at
)
SELECT
  :'U0', e.id, random() < 0.5, random() < 0.1, NULL, false,
  COALESCE(e.published_at, e.fetched_at), now(), now(), now()
FROM entries e WHERE e.feed_id = :'SAVED_FEED';

-- ---------------------------------------------------------------------------
-- Stats
-- ---------------------------------------------------------------------------
ANALYZE;

SELECT 'users' AS t, count(*) FROM users
UNION ALL SELECT 'feeds', count(*) FROM feeds
UNION ALL SELECT 'entries', count(*) FROM entries
UNION ALL SELECT 'subscriptions', count(*) FROM subscriptions
UNION ALL SELECT 'user_entries', count(*) FROM user_entries
UNION ALL SELECT 'U0 user_entries', count(*) FROM user_entries WHERE user_id = :'U0'
UNION ALL SELECT 'U0 unread', count(*) FROM user_entries WHERE user_id = :'U0' AND read = false
UNION ALL SELECT 'U0 starred', count(*) FROM user_entries WHERE user_id = :'U0' AND starred = true;
