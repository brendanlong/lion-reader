-- #1846 phase 7B: every feed is a web feed, so the columns left from the
-- per-user email and saved feeds go: type (always 'web'; the feed_type enum
-- stays for subscriptions and entries), user_id and email_sender_pattern
-- (always NULL), with their indexes and check. The previous release names none
-- of them. Its own migration, so feeds' lock isn't held with user_entries'.
-- Catalog only.
SET LOCAL lock_timeout = '5s';

-- Up front, so nothing below upgrades a lock: users for the feeds.user_id
-- foreign key.
LOCK TABLE feeds, users IN ACCESS EXCLUSIVE MODE;

ALTER TABLE feeds DROP CONSTRAINT feeds_web_only;
DROP INDEX idx_feeds_type;
DROP INDEX idx_feeds_user_id;
DROP INDEX uq_feeds_saved_user;
ALTER TABLE feeds
  DROP CONSTRAINT uq_feeds_email_user_sender,
  DROP COLUMN type,
  DROP COLUMN user_id,
  DROP COLUMN email_sender_pattern;
