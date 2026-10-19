-- Validates 0153's check. Its own migration (transaction), so scanning entries
-- holds only SHARE UPDATE EXCLUSIVE, which lets reads and writes go on.
SET LOCAL lock_timeout = '5s';
ALTER TABLE entries VALIDATE CONSTRAINT entries_last_seen_only_fetched;
