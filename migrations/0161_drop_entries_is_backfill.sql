-- The backfill verdict is judged per link now (#2036), so nothing reads or
-- writes this column (#2051).
ALTER TABLE entries DROP COLUMN is_backfill;
