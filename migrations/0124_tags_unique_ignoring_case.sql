-- Tag names are unique per user ignoring case (#1846). The new index implies
-- the old case-sensitive one. Nothing names the old index in an ON CONFLICT
-- target, so the previous release keeps working: its duplicate checks catch
-- any unique violation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tags_user_lower_name ON tags (user_id, lower(name)) WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS uq_tags_user_name;
