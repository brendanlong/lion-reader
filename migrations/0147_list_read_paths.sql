-- Timeline order for the sparse lists: the unread and starred partial indexes
-- carry the timeline's sort key, so an unread or starred page reads only
-- matching rows instead of walking the user's whole timeline and filtering.
-- Leading with user_id, they still serve the unordered per-user lookups
-- (mark-all-read, the counters' recomputes) the (user_id)-only ones did.
SET LOCAL lock_timeout = '5s';

-- Build before dropping: a build takes a SHARE lock (reads continue), a drop
-- an ACCESS EXCLUSIVE one, which would otherwise be held across the builds.
CREATE INDEX IF NOT EXISTS idx_user_entries_unread_timeline
  ON user_entries (user_id, published_or_fetched_at DESC, entry_id DESC) WHERE NOT read;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_entries_starred_timeline
  ON user_entries (user_id, published_or_fetched_at DESC, entry_id DESC) WHERE starred;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_user_entries_unread;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_user_entries_starred;
--> statement-breakpoint
-- visible_entries takes every column a list filters or sorts on by default
-- from user_entries (`id`, and `is_spam`, which is copied from the entry at
-- insert and never changes, and which the unread counters already read) and
-- LEFT JOINs entries, which every row has (foreign key). Postgres joins an
-- outer join's inner side after the outer side's filters, so a list page
-- filters on user_entries alone and reads entry rows only for the rows that
-- pass, where an inner join let it read the entry of every row it walked. A
-- filter on an entries column (type, search) makes it an inner join again.
CREATE OR REPLACE VIEW visible_entries AS
 SELECT ue.user_id,
    ue.entry_id AS id,
    e.owner_feed_id,
    e.type,
    e.guid,
    e.url,
    e.title,
    e.author,
    e.content_original,
    e.content_cleaned,
    e.summary,
    e.site_name,
    e.image_url,
    e.published_at,
    e.fetched_at,
    e.last_seen_at,
    e.content_hash,
    e.full_content_hash,
    e.spam_score,
    ue.is_spam,
    e.list_unsubscribe_mailto,
    e.list_unsubscribe_https,
    e.list_unsubscribe_post,
    e.created_at,
    GREATEST(e.updated_at, ue.updated_at) AS updated_at,
    e.full_content_original,
    e.full_content_cleaned,
    e.full_content_fetched_at,
    e.full_content_error,
    ue.read,
    ue.starred,
    e.unsubscribe_url,
    ue.read_changed_at,
    ue.published_or_fetched_at,
    e.greader_item_id,
    e.search_vector,
    e.updated_at AS entry_updated_at
   FROM user_entries ue
     LEFT JOIN entries e ON e.id = ue.entry_id
  WHERE ue.starred OR ue.active_memberships > 0;
