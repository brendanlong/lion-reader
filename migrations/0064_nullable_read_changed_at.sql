-- Make read_changed_at nullable on user_entries so it only has a value when
-- the user has explicitly changed the read state. Previously it defaulted to
-- NOW() on row creation, causing the "Recently Read" list to include entries
-- the user had never actually read.
--
-- Also adds a created_at column to user_entries for general housekeeping.

-- Step 1: Add created_at column (nullable initially for backfill)
ALTER TABLE user_entries ADD COLUMN created_at timestamptz;

-- Step 2: Backfill created_at from the later of entries.created_at and
-- subscriptions.created_at (whichever event triggered the row).
-- GREATEST in Postgres ignores NULLs, so orphaned starred entries
-- (no subscription) just get entries.created_at.
-- Note: In UPDATE...FROM, the target table can't be referenced in JOIN
-- conditions, so we use a subquery to compute the value.
UPDATE user_entries ue
SET created_at = sub.computed_created_at
FROM (
    SELECT ue2.user_id, ue2.entry_id,
           GREATEST(e.created_at, s.created_at) AS computed_created_at
    FROM user_entries ue2
    JOIN entries e ON e.id = ue2.entry_id
    LEFT JOIN subscription_feeds sf ON sf.user_id = ue2.user_id AND sf.feed_id = e.feed_id
    LEFT JOIN subscriptions s ON s.id = sf.subscription_id
) sub
WHERE ue.user_id = sub.user_id AND ue.entry_id = sub.entry_id;

-- Step 3: Any remaining NULLs (shouldn't happen, but be safe) get NOW()
UPDATE user_entries SET created_at = NOW() WHERE created_at IS NULL;

-- Step 4: Make NOT NULL with default
ALTER TABLE user_entries ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE user_entries ALTER COLUMN created_at SET DEFAULT NOW();

-- Step 5: Make read_changed_at nullable and change default to NULL
ALTER TABLE user_entries ALTER COLUMN read_changed_at DROP NOT NULL;
ALTER TABLE user_entries ALTER COLUMN read_changed_at SET DEFAULT NULL;

-- Step 6: Set read_changed_at to NULL for entries that were never explicitly
-- read-state-changed by the user. If read is false and none of the interaction
-- flags are set, the timestamp is just the row-creation default.
UPDATE user_entries
SET read_changed_at = NULL
WHERE read = false
  AND has_marked_read_on_list = false
  AND has_marked_unread = false;

-- Step 7: Recreate visible_entries view (CREATE OR REPLACE can't change column
-- types, but the column is still projected the same way — it's just nullable now).
-- We need to DROP and recreate because the underlying column type changed.
DROP VIEW IF EXISTS public.visible_entries;
CREATE VIEW public.visible_entries AS
SELECT ue.user_id,
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
    GREATEST(e.updated_at, ue.updated_at) AS updated_at,
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
    s.id AS subscription_id,
    esp.predicted_score,
    esp.confidence AS prediction_confidence,
    e.unsubscribe_url,
    ue.read_changed_at,
    e.wallabag_id
FROM public.user_entries ue
    JOIN public.entries e ON e.id = ue.entry_id
    LEFT JOIN public.subscription_feeds sf ON sf.user_id = ue.user_id AND sf.feed_id = e.feed_id
    LEFT JOIN public.subscriptions s ON s.id = sf.subscription_id
    LEFT JOIN public.entry_score_predictions esp ON esp.user_id = ue.user_id AND esp.entry_id = e.id
WHERE s.unsubscribed_at IS NULL OR ue.starred = true;
