-- Entries share the feed_type enum with feeds, but no entry is ever a
-- collection (collections reference other feeds' entries; #1806).
-- Its own migration so the brief ACCESS EXCLUSIVE lock on entries commits at
-- once. NOT VALID skips scanning existing rows, none of which can be a
-- collection; new and updated rows are still checked.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE entries ADD CONSTRAINT entries_type_not_collection CHECK (type <> 'collection') NOT VALID;
