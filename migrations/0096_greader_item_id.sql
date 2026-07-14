-- Give each entry a stable global integer id for the Google Reader API (issue
-- #1117, step 6a).
--
-- Google Reader clients require signed 64-bit integer item IDs. We used to
-- derive them at runtime by projecting each entry's UUIDv7 to an int64
-- (uuidToInt64) and reverse-lookup the UUID with an expensive timestamp-window
-- index scan. That machinery is replaced by a plain global serial column so an
-- item id is just a stored bigint: format reads entries.greader_item_id and the
-- reverse lookup is a trivial `greader_item_id = ANY(...)` seek on a unique
-- index.
--
-- Google Reader clients re-sync from scratch after this (item ids change); this
-- is accepted (few users). Feed stream ids, tag sortids, and user ids still use
-- uuidToInt64 — those are a later step.
--
-- Cost: the runner wraps the whole migration in one transaction, so ADD
-- COLUMN's ACCESS EXCLUSIVE lock on `entries` is held through the backfill and
-- index build, briefly blocking the previous release's entry reads/writes. The
-- window is short (~1.5s measured): `entries`' large content columns are TOASTed
-- out of line, so the backfill UPDATE rewrites only the small main-heap tuples,
-- not the 4.2 GB total relation size. Same single-transaction add-nullable →
-- backfill → SET NOT NULL pattern as migration 0086 (on the larger user_entries).
-- Expand-only: the previous release ignores the new column; release_command runs
-- before the canary, so this blocks only the pre-deploy window, not live traffic.

ALTER TABLE entries ADD COLUMN greader_item_id bigint;
--> statement-breakpoint
CREATE SEQUENCE entries_greader_item_id_seq OWNED BY entries.greader_item_id;
--> statement-breakpoint
ALTER TABLE entries ALTER COLUMN greader_item_id SET DEFAULT nextval('entries_greader_item_id_seq');
--> statement-breakpoint
UPDATE entries SET greader_item_id = nextval('entries_greader_item_id_seq') WHERE greader_item_id IS NULL;
--> statement-breakpoint
ALTER TABLE entries ALTER COLUMN greader_item_id SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_entries_greader_item_id ON entries(greader_item_id);
--> statement-breakpoint
DROP VIEW visible_entries;
--> statement-breakpoint
CREATE VIEW visible_entries AS
 SELECT ue.user_id,
    e.id,
    e.feed_id,
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
    e.is_spam,
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
    s.id AS subscription_id,
    e.unsubscribe_url,
    ue.read_changed_at,
    e.wallabag_id,
    ue.published_or_fetched_at,
    e.content_original_sanitized,
    e.content_cleaned_sanitized,
    e.content_sanitized_version,
    e.full_content_original_sanitized,
    e.full_content_cleaned_sanitized,
    e.full_content_sanitized_version,
    e.greader_item_id
   FROM ((user_entries ue
     JOIN entries e ON ((e.id = ue.entry_id)))
     LEFT JOIN subscriptions s ON ((s.id = ue.subscription_id)))
  WHERE (((s.id IS NOT NULL) AND (s.unsubscribed_at IS NULL)) OR (ue.starred = true) OR (e.type = 'saved'::feed_type));
