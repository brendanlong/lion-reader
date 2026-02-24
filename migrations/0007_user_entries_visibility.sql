-- Rename user_entry_states to user_entries
-- This table now serves dual purpose: visibility tracking AND read/starred state
-- Row existence means the entry is visible to the user

-- Rename the table
ALTER TABLE "user_entry_states" RENAME TO "user_entries";

-- Rename the indexes
ALTER INDEX "idx_user_entry_states_unread" RENAME TO "idx_user_entries_unread";
ALTER INDEX "idx_user_entry_states_starred" RENAME TO "idx_user_entries_starred";

-- Backfill user_entries for existing subscriptions
-- For each active subscription, create user_entries rows for entries
-- where the entry was fetched after the user subscribed
INSERT INTO "user_entries" ("user_id", "entry_id", "read", "starred")
SELECT
    s.user_id,
    e.id,
    false,
    false
FROM subscriptions s
INNER JOIN entries e ON e.feed_id = s.feed_id
WHERE s.unsubscribed_at IS NULL
  AND e.fetched_at >= s.subscribed_at
ON CONFLICT DO NOTHING;
