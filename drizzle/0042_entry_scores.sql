-- Migration: Add explicit and implicit scoring to user_entries
--
-- Explicit score: User-voted score (-2 to +2), null means no vote, 0 means voted neutral
-- Implicit signals: Boolean flags tracking user actions that imply interest/disinterest
--   - has_marked_read_on_list: marked read from entry list (not entry view) → implies -1
--   - has_marked_unread: marked unread from anywhere → implies +1
--   - has_starred: starred the entry → implies +2
-- Display score: explicit_score ?? computed_implicit_score
-- Implicit score priority: starred (+2) > unread (+1) > read-on-list (-1) > default (0)

-- Add score columns
ALTER TABLE user_entries
  ADD COLUMN score smallint,
  ADD COLUMN score_changed_at timestamptz,
  ADD COLUMN has_marked_read_on_list boolean NOT NULL DEFAULT false,
  ADD COLUMN has_marked_unread boolean NOT NULL DEFAULT false,
  ADD COLUMN has_starred boolean NOT NULL DEFAULT false;

-- Constrain explicit score range
ALTER TABLE user_entries
  ADD CONSTRAINT user_entries_score_range CHECK (score BETWEEN -2 AND 2);

-- Recreate visible_entries view to include new columns
DROP VIEW IF EXISTS visible_entries;

CREATE VIEW visible_entries AS
SELECT
  ue.user_id,
  e.id,
  e.feed_id,
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
  e.updated_at,
  e.full_content_original,
  e.full_content_cleaned,
  e.full_content_fetched_at,
  e.full_content_error,
  ue.read,
  ue.starred,
  ue.score,
  ue.has_marked_read_on_list,
  ue.has_marked_unread,
  ue.has_starred,
  s.id AS subscription_id
FROM user_entries ue
JOIN entries e ON e.id = ue.entry_id
LEFT JOIN subscriptions s ON (
  s.user_id = ue.user_id
  AND e.feed_id = ANY(s.feed_ids)
)
WHERE
  s.unsubscribed_at IS NULL
  OR ue.starred = true;
