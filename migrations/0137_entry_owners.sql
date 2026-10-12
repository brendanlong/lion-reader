-- Entries name their owner (#1846 phase 6A): exactly one of
--   owner_feed_id          a web entry's feed, shared by its subscribers;
--   owner_subscription_id  an email's subscription (one per user and sender);
--   owner_user_id          a saved article's or upload's user.
-- The owner gives duplicate detection (a unique (owner, guid) per kind) and
-- cascade delete; it's never used to list or count.
--
-- **Deployed under maintenance mode**: the previous release names
-- entries.feed_id, which this renames to owner_feed_id in place (catalog
-- only, no rewrite) rather than copying it to a new column. Email and saved
-- entries keep owner_feed_id = their per-user feed until phase 6B clears it;
-- scripts/backfill-entry-owners.ts gives them their owner_subscription_id /
-- owner_user_id while maintenance is still on.
--
-- PL/pgSQL bodies are stored as text and don't follow a rename: every
-- function naming the column is redefined here.
--
-- Also drops subscriptions.starred_unread_count, unmaintained since 0133 and
-- unmapped by the previous release.
SET LOCAL lock_timeout = '5s';
LOCK TABLE entries IN ACCESS EXCLUSIVE MODE;
LOCK TABLE subscriptions IN ACCESS EXCLUSIVE MODE;

ALTER TABLE entries RENAME COLUMN feed_id TO owner_feed_id;
ALTER TABLE entries RENAME CONSTRAINT entries_feed_id_feeds_id_fk TO entries_owner_feed_id_feeds_id_fk;
ALTER TABLE entries RENAME CONSTRAINT uq_entries_feed_guid TO uq_entries_owner_feed_guid;
ALTER INDEX uq_entries_feed_guid_canonical RENAME TO uq_entries_owner_feed_guid_canonical;
ALTER INDEX idx_entries_feed RENAME TO idx_entries_owner_feed;
ALTER INDEX idx_entries_feed_published_coalesce RENAME TO idx_entries_owner_feed_published_coalesce;
ALTER INDEX idx_entries_feed_updated_at RENAME TO idx_entries_owner_feed_updated_at;
ALTER INDEX idx_entries_fetched RENAME TO idx_entries_owner_feed_fetched;
ALTER INDEX idx_entries_last_seen RENAME TO idx_entries_owner_feed_last_seen;
ALTER INDEX idx_entries_spam RENAME TO idx_entries_owner_feed_spam;
ALTER VIEW visible_entries RENAME COLUMN feed_id TO owner_feed_id;
-- PG 18 names NOT NULL constraints too; its name depends on how the table
-- was created or restored, so look it up.
DO $$
DECLARE v_name text;
BEGIN
  SELECT c.conname INTO v_name
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.conrelid = 'entries'::regclass AND c.contype = 'n' AND a.attname = 'owner_feed_id';
  IF v_name IS NOT NULL AND v_name <> 'entries_owner_feed_id_not_null' THEN
    EXECUTE format('ALTER TABLE entries RENAME CONSTRAINT %I TO entries_owner_feed_id_not_null', v_name);
  END IF;
END $$;

-- The only function naming entries.feed_id (as in 0133, otherwise unchanged).
CREATE OR REPLACE FUNCTION user_entries_fill_denormalized() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_feed_id uuid;
  v_type feed_type;
BEGIN
  IF NEW.published_or_fetched_at IS NULL
     OR NEW.is_spam IS NULL
     OR NEW.subscription_id IS NULL THEN
    SELECT COALESCE(NEW.published_or_fetched_at, e.published_at, e.fetched_at),
           COALESCE(NEW.is_spam, e.is_spam),
           e.owner_feed_id, e.type
      INTO NEW.published_or_fetched_at, NEW.is_spam, v_feed_id, v_type
      FROM entries e
      WHERE e.id = NEW.entry_id;
    IF NEW.subscription_id IS NULL THEN
      SELECT s.id
        INTO NEW.subscription_id
        FROM subscriptions s
        WHERE s.user_id = NEW.user_id
          AND s.feed_id = v_feed_id;
    END IF;
  END IF;
  IF NEW.subscription_id IS NOT NULL THEN
    NEW.active_memberships := (
      SELECT count(*) FROM subscriptions s
      WHERE s.id = NEW.subscription_id AND s.unsubscribed_at IS NULL
    );
  ELSIF v_type = 'saved' THEN
    NEW.active_memberships := 1;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE entries
  ADD COLUMN owner_subscription_id uuid REFERENCES subscriptions(id) ON DELETE CASCADE,
  ADD COLUMN owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
-- Duplicate detection for emails (Message-ID) and saved articles (URL), the
-- cascades, and delta sync's per-owner seek. Partial, so they're empty until
-- the backfill.
CREATE UNIQUE INDEX uq_entries_owner_subscription_guid
  ON entries (owner_subscription_id, guid) WHERE owner_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX uq_entries_owner_user_guid
  ON entries (owner_user_id, guid) WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_entries_owner_subscription_updated_at
  ON entries (owner_subscription_id, updated_at) WHERE owner_subscription_id IS NOT NULL;
CREATE INDEX idx_entries_owner_user_updated_at
  ON entries (owner_user_id, updated_at) WHERE owner_user_id IS NOT NULL;

ALTER TABLE subscriptions DROP COLUMN starred_unread_count;

-- The sender an email subscription receives from. Phase 6B moves it off the
-- per-user email feed (feeds.email_sender_pattern), which goes away.
ALTER TABLE subscriptions ADD COLUMN email_sender text;
UPDATE subscriptions s
SET email_sender = f.email_sender_pattern
FROM feeds f
WHERE f.id = s.feed_id AND s.type = 'email';
CREATE UNIQUE INDEX uq_subscriptions_user_email_sender
  ON subscriptions (user_id, email_sender) WHERE type = 'email';
