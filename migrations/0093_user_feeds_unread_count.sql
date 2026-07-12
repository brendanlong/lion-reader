-- Expose the denormalized subscriptions.unread_count through the user_feeds
-- view (issue #1117, step 5b), so the subscription-list query reads the
-- trigger-maintained counter instead of aggregating over visible_entries.
--
-- The column is APPENDED so CREATE OR REPLACE VIEW is valid, and old code
-- simply ignores it (expand/contract-safe).

CREATE OR REPLACE VIEW user_feeds AS
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
    f.description,
    s.unread_count
   FROM (subscriptions s
     JOIN feeds f ON ((f.id = s.feed_id)))
  WHERE (s.unsubscribed_at IS NULL);
