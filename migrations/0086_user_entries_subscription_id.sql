-- Stamp user_entries with a direct 1:1 subscription attribution + denormalized
-- spam flag (issue #1117, step 3 of the refactor plan).
--
-- `subscription_id` is INFORMATIONAL during the transition: entry visibility is
-- still resolved through the subscription_feeds junction (visible_entries view).
-- A later release flips visibility to this column and drops the junction, but
-- only after the stamped values have been reconciled against the junction-derived
-- ones in production (see "Entry Visibility" in docs/DESIGN.md).
--
-- NULL subscription_id = saved/uploaded article (per-user feed with no
-- subscription row). `is_spam` is a copy of entries.is_spam, which is immutable
-- after insert (set only by email ingest from the provider's verdict), so it can
-- be denormalized the same way as published_or_fetched_at.
--
-- Rollout safety (expand/contract): the BEFORE INSERT trigger below fills both
-- columns when a caller omits them, so inserts from the previous release during
-- the canary rollout are stamped correctly too — there is no window of NULL rows
-- after the backfill. Hot bulk paths (feed fanout, subscribe populate) set the
-- columns inline so the trigger's per-row lookups are skipped there.

-- ON DELETE SET NULL, not CASCADE: subscriptions are only ever soft-deleted
-- today, but if a hard-delete path ever appears, cascading would destroy the
-- user's read/star state. SET NULL just drops the attribution — and stays
-- fail-closed after the future visibility flip, because the saved-article
-- visibility arm checks the entry type, never "subscription_id IS NULL".
ALTER TABLE user_entries
  ADD COLUMN subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE user_entries ADD COLUMN is_spam boolean;
--> statement-breakpoint

-- Backfill (~280k rows / 167 MB in prod as of 2026-07: seconds, not minutes).
-- Attribution rule for the subscription: prefer an active subscription, then a
-- direct feed match (over redirect/merge junction history), then the most
-- recently subscribed. Prod audit found only 12 rows where this choice is
-- ambiguous (all from feed merges), and for those the active/survivor
-- subscription is the correct owner.
UPDATE user_entries ue
SET is_spam = e.is_spam,
    subscription_id = (
      SELECT sf.subscription_id
      FROM subscription_feeds sf
      JOIN subscriptions s ON s.id = sf.subscription_id
      WHERE sf.user_id = ue.user_id
        AND sf.feed_id = e.feed_id
      ORDER BY (s.unsubscribed_at IS NULL) DESC,
               (s.feed_id = e.feed_id) DESC,
               s.subscribed_at DESC,
               s.id DESC
      LIMIT 1
    )
FROM entries e
WHERE e.id = ue.entry_id;
--> statement-breakpoint

-- Safe immediately: the trigger below fills is_spam before the constraint is
-- checked, so inserts that omit it (previous release, tests, seeds) still pass.
ALTER TABLE user_entries ALTER COLUMN is_spam SET NOT NULL;
--> statement-breakpoint

-- Replace the sort-key fill trigger with one that fills all denormalized
-- columns. Same contract as before: callers may omit the columns and rely on
-- the trigger; bulk paths populate inline, making it a no-op there.
DROP TRIGGER user_entries_fill_sort_key_trigger ON user_entries;
--> statement-breakpoint
DROP FUNCTION user_entries_fill_sort_key();
--> statement-breakpoint
CREATE FUNCTION user_entries_fill_denormalized() RETURNS trigger AS $$
DECLARE
  v_feed_id uuid;
BEGIN
  IF NEW.published_or_fetched_at IS NULL
     OR NEW.is_spam IS NULL
     OR NEW.subscription_id IS NULL THEN
    SELECT COALESCE(NEW.published_or_fetched_at, e.published_at, e.fetched_at),
           COALESCE(NEW.is_spam, e.is_spam),
           e.feed_id
      INTO NEW.published_or_fetched_at, NEW.is_spam, v_feed_id
      FROM entries e
      WHERE e.id = NEW.entry_id;
    -- (user_id, feed_id) is unique on subscriptions, so this finds the one
    -- subscription for the entry's feed, active or not. Saved/uploaded
    -- articles live in a per-user feed with no subscription row, so the
    -- lookup finds nothing and subscription_id stays NULL — by design.
    IF NEW.subscription_id IS NULL THEN
      SELECT s.id
        INTO NEW.subscription_id
        FROM subscriptions s
        WHERE s.user_id = NEW.user_id
          AND s.feed_id = v_feed_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER user_entries_fill_denormalized_trigger
  BEFORE INSERT ON user_entries
  FOR EACH ROW
  EXECUTE FUNCTION user_entries_fill_denormalized();
--> statement-breakpoint

-- For the feed-merge re-stamp (UPDATE ... WHERE subscription_id = <old>) and
-- the upcoming subscription-scoped entry queries/counters.
CREATE INDEX idx_user_entries_subscription
  ON user_entries (subscription_id)
  WHERE subscription_id IS NOT NULL;
