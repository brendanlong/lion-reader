-- Tag names are unique per user ignoring case (#1846). The new index implies
-- the old case-sensitive one, and nothing names the old one in an ON CONFLICT
-- target. The previous release still matches names exactly, so until it's
-- gone its OPML import and Google Reader label-add can fail on a name that
-- differs from an existing tag only in case; nothing is written wrongly.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tags_user_lower_name ON tags (user_id, lower(name)) WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS uq_tags_user_name;
