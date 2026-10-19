-- Only polls stamp last_seen_at: a web entry a WebSub push inserts keeps it
-- NULL until a poll sees it in the feed. The check only keeps last_seen_at off
-- email and saved entries. The previous release always writes it for web
-- entries, which the relaxed check still allows.
-- Its own migration so the brief ACCESS EXCLUSIVE lock on entries commits at
-- once. NOT VALID skips the scan: every existing row satisfies the stricter old
-- check. 0154 validates it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE entries DROP CONSTRAINT entries_last_seen_only_fetched;
--> statement-breakpoint
ALTER TABLE entries ADD CONSTRAINT entries_last_seen_only_fetched
  CHECK (type = 'web' OR last_seen_at IS NULL) NOT VALID;
