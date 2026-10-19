-- The last WebSub push that announced an entry. An entry announced after the
-- feed's last poll is current for a new subscriber until the next poll, which
-- either stamps last_seen_at or leaves it out (currentEntryIdsSql). Nullable with
-- no default, so adding it doesn't rewrite entries; the previous release never
-- reads or writes it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE entries ADD COLUMN pushed_at timestamptz;
