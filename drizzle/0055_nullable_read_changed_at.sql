-- Make read_changed_at nullable so entries that have never had their read state
-- explicitly changed by the user have NULL, distinguishing them from entries
-- the user has actually interacted with. This fixes the "Recently Read" list
-- which sorts by read_changed_at and previously showed all entries.

-- 1. Drop the NOT NULL constraint and change default to NULL
ALTER TABLE user_entries ALTER COLUMN read_changed_at DROP NOT NULL;
ALTER TABLE user_entries ALTER COLUMN read_changed_at SET DEFAULT NULL;

-- 2. Set existing rows to NULL where the user never explicitly changed read state.
-- An entry was explicitly interacted with if the user marked it read from the list,
-- marked it unread, or if it's currently read (auto-read-on-open also counts).
UPDATE user_entries
SET read_changed_at = NULL
WHERE has_marked_read_on_list = false
  AND has_marked_unread = false
  AND read = false;
