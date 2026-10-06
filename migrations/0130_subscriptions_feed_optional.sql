-- A subscription may have no feed (#1846, phase 3A): collections will stop
-- having feed rows. Its type and name are its own (subscriptions.type and
-- custom_title), so every read takes them from the subscription.
-- Both statements take an ACCESS EXCLUSIVE lock on a table the counter
-- triggers update constantly; fail fast rather than queue every write behind
-- them. Dropping NOT NULL scans nothing.
SET LOCAL lock_timeout = '5s';

ALTER TABLE subscriptions ALTER COLUMN feed_id DROP NOT NULL;

-- Same columns. A feedless subscription gets NULL feed fields, except
-- original_title, which is its name (as sync and created events report it).
CREATE OR REPLACE VIEW user_feeds AS
 SELECT s.id,
    s.user_id,
    s.subscribed_at,
    s.created_at,
    s.feed_id,
    s.custom_title,
    s.fetch_full_content,
    s.type,
    COALESCE(s.custom_title, f.title) AS title,
    COALESCE(f.title, s.custom_title) AS original_title,
    f.url,
    f.site_url,
    f.description,
    s.unread_count,
    s.greader_stream_id
   FROM subscriptions s
     LEFT JOIN feeds f ON f.id = s.feed_id
  WHERE s.unsubscribed_at IS NULL;
