-- Migration: Replace feed_ids array column with subscription_feeds junction table
--
-- Background: The subscriptions.feed_ids column (a generated array combining feed_id
-- and previous_feed_ids) was used in the visible_entries view join:
--   LEFT JOIN subscriptions s ON s.feed_ids @> ARRAY[e.feed_id]
-- This array containment join creates O(entries × subscriptions) intermediate rows
-- because PostgreSQL's GIN index cannot be used in this join direction, causing
-- 10-50x slower queries than necessary.
--
-- Solution: A junction table subscription_feeds(subscription_id, feed_id) with scalar
-- equality joins enables hash joins and btree index usage.
--
-- This migration is atomic: it creates the new table, populates it, updates both
-- views, and drops the old columns in a single transaction.

-- Step 1: Create subscription_feeds junction table
CREATE TABLE public.subscription_feeds (
    subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
    feed_id uuid NOT NULL REFERENCES public.feeds(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    PRIMARY KEY (subscription_id, feed_id)
);

-- Step 2: Populate from existing data (all subscriptions, active and unsubscribed)
-- ON CONFLICT handles potential duplicate feed_ids from redirect chains
INSERT INTO public.subscription_feeds (subscription_id, feed_id, user_id)
SELECT s.id, unnest(s.feed_ids), s.user_id
FROM public.subscriptions s
ON CONFLICT DO NOTHING;

-- Step 3: Create indexes for efficient joins
CREATE INDEX idx_subscription_feeds_user_feed ON public.subscription_feeds (user_id, feed_id);
CREATE INDEX idx_subscription_feeds_feed ON public.subscription_feeds (feed_id);

-- Step 4: Replace visible_entries view to use junction table
CREATE OR REPLACE VIEW public.visible_entries AS
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

-- Step 5: Drop and recreate user_feeds view to remove feed_ids column
-- (CREATE OR REPLACE can't remove columns, so we must DROP first)
DROP VIEW IF EXISTS public.user_feeds;
CREATE VIEW public.user_feeds AS
SELECT s.id,
    s.user_id,
    s.subscribed_at,
    s.created_at,
    s.feed_id,
    s.custom_title,
    s.fetch_full_content,
    f.type,
    COALESCE(s.custom_title, f.title) AS title,
    f.title AS original_title,
    f.url,
    f.site_url,
    f.description
FROM public.subscriptions s
    JOIN public.feeds f ON f.id = s.feed_id
WHERE s.unsubscribed_at IS NULL;

-- Step 6: Drop old columns and indexes
-- Drop generated column first (depends on previous_feed_ids)
ALTER TABLE public.subscriptions DROP COLUMN feed_ids;
ALTER TABLE public.subscriptions DROP COLUMN previous_feed_ids;

-- Drop the now-unused GIN indexes (they were on the dropped columns)
-- These are automatically dropped when the columns are dropped, but be explicit
DROP INDEX IF EXISTS public.idx_subscriptions_feed_ids;
DROP INDEX IF EXISTS public.idx_subscriptions_previous_feed_ids;
