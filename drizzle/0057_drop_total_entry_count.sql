-- Drop total_entry_count column from feeds.
-- This column was added in 0056 but is no longer needed since we compute
-- the count at query time via COUNT(*) subquery on the entries table.
ALTER TABLE feeds DROP COLUMN total_entry_count;
