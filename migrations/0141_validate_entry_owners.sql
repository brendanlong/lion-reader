-- Step 4 of 4 (see 0138): validate 0140's exactly-one-owner check, and
-- entries_type_not_collection, which it relies on to mean exactly one owner.
-- Its own migration (transaction), so scanning entries holds only SHARE
-- UPDATE EXCLUSIVE, which lets reads and writes go on.
SET LOCAL lock_timeout = '5s';
ALTER TABLE entries VALIDATE CONSTRAINT entries_owner_matches_type;
ALTER TABLE entries VALIDATE CONSTRAINT entries_type_not_collection;
