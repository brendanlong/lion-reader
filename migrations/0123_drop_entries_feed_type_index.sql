-- (feed_id, type) is a near-duplicate of idx_entries_spam (feed_id, is_spam):
-- the planner uses either one, both compact thanks to B-tree deduplication,
-- for plain feed_id lookups, and production scans this one rarely. Dropping it
-- moves those few lookups onto idx_entries_spam at the same cost (#1846).
DROP INDEX IF EXISTS idx_entries_feed_type;
