-- The fetched pages are archived to object storage instead (#2115), and the
-- backfill cleared every row. Dropping the column only updates the catalog: the
-- space was already freed for reuse when the values were cleared.
SET LOCAL lock_timeout = '5s';

ALTER TABLE entries DROP COLUMN full_content_original;
