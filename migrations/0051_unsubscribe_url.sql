-- Add unsubscribe_url column to entries table
-- Stores the unsubscribe link extracted from newsletter email HTML content.
-- This is separate from list_unsubscribe_mailto/https which come from email headers.

ALTER TABLE entries ADD COLUMN unsubscribe_url text;

-- Update the visible_entries view to include the new column.
-- New columns must be appended at the end (CREATE OR REPLACE VIEW cannot
-- reorder existing columns).
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
    e.unsubscribe_url
FROM (((public.user_entries ue
    JOIN public.entries e ON ((e.id = ue.entry_id)))
    LEFT JOIN public.subscriptions s ON (((s.user_id = ue.user_id) AND (e.feed_id = ANY (s.feed_ids)))))
    LEFT JOIN public.entry_score_predictions esp ON (((esp.user_id = ue.user_id) AND (esp.entry_id = e.id))))
WHERE ((s.unsubscribed_at IS NULL) OR (ue.starred = true));
