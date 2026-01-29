-- Update entries_last_seen_only_fetched constraint to include lesswrong
-- LessWrong API feeds track lastSeenAt like web feeds
-- (Must be in separate migration so the enum value is committed first)
ALTER TABLE "entries" DROP CONSTRAINT IF EXISTS "entries_last_seen_only_fetched";
ALTER TABLE "entries" ADD CONSTRAINT "entries_last_seen_only_fetched"
  CHECK ((type IN ('web', 'lesswrong')) = (last_seen_at IS NOT NULL));
