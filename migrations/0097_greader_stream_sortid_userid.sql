-- Give subscriptions, feeds, tags, and users stable integer ids for the Google
-- Reader API (issue #1117, step 6b). This finishes the compat-id migration
-- started in 0096 (item ids) and lets us delete uuidToInt64 and its
-- timestamp-window reverse-lookup machinery entirely.
--
-- Google Reader clients need signed 64-bit integer ids for feed streams,
-- subscription/tag sortids, and the user id. We used to derive all of these at
-- runtime by projecting a UUIDv7 to an int64 (uuidToInt64) and — for feed
-- streams — reverse-lookup the UUID with an expensive timestamp-window scan over
-- candidates. That projection is lossy (63 bits) and its reverse lookup is
-- fragile; replace it with stored serial columns so each id is just a bigint and
-- the feed-stream reverse lookup is a unique-index seek.
--
-- One shared sequence backs all four columns. Feed streams address BOTH real
-- subscriptions and the per-user saved-articles feed (which has no subscription
-- row — issue #730), so their ids must be globally unique across the two tables:
-- resolveFeedStream tries subscriptions first, then the saved feed, and a
-- collision would make a saved feed sharing a subscription's id unreachable.
-- Drawing every greader id from one sequence guarantees that (and, as a bonus,
-- that no user id can equal a feed stream id). tags.greader_sortid and
-- users.greader_user_id are opaque (never reversed), so they need no index.
--
-- Google Reader clients re-sync from scratch after this (feed stream ids and
-- sortids change). This is accepted (few users; item ids already changed in
-- 0096, so push-active clients are re-syncing anyway).
--
-- Cost: like 0096, the runner wraps the whole migration in one transaction, so
-- each ADD COLUMN's ACCESS EXCLUSIVE lock is held through its backfill, briefly
-- blocking the previous release. These tables are tiny (subscriptions ~1.7k,
-- feeds/tags/users comparable) with no out-of-line content, so the backfills are
-- sub-second. Expand-only: the previous release ignores the new columns and the
-- added view columns; release_command runs before the canary, so this blocks
-- only the pre-deploy window, not live traffic.

CREATE SEQUENCE greader_id_seq;
--> statement-breakpoint

-- subscriptions.greader_stream_id — backs the feed/{int} stream id + sortid;
-- reversed by feedStreamIdToSubscriptionUuid / resolveFeedStream (unique seek).
ALTER TABLE subscriptions ADD COLUMN greader_stream_id bigint;
--> statement-breakpoint
ALTER TABLE subscriptions ALTER COLUMN greader_stream_id SET DEFAULT nextval('greader_id_seq');
--> statement-breakpoint
UPDATE subscriptions SET greader_stream_id = nextval('greader_id_seq') WHERE greader_stream_id IS NULL;
--> statement-breakpoint
ALTER TABLE subscriptions ALTER COLUMN greader_stream_id SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_subscriptions_greader_stream_id ON subscriptions(greader_stream_id);
--> statement-breakpoint

-- feeds.greader_stream_id — only the saved-articles feed is exposed as a stream,
-- but every feed gets one from the shared sequence so the value space stays
-- disjoint from subscriptions (see resolveFeedStream note above).
ALTER TABLE feeds ADD COLUMN greader_stream_id bigint;
--> statement-breakpoint
ALTER TABLE feeds ALTER COLUMN greader_stream_id SET DEFAULT nextval('greader_id_seq');
--> statement-breakpoint
UPDATE feeds SET greader_stream_id = nextval('greader_id_seq') WHERE greader_stream_id IS NULL;
--> statement-breakpoint
ALTER TABLE feeds ALTER COLUMN greader_stream_id SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_feeds_greader_stream_id ON feeds(greader_stream_id);
--> statement-breakpoint

-- tags.greader_sortid — opaque folder sortid; never reversed, so no index.
ALTER TABLE tags ADD COLUMN greader_sortid bigint;
--> statement-breakpoint
ALTER TABLE tags ALTER COLUMN greader_sortid SET DEFAULT nextval('greader_id_seq');
--> statement-breakpoint
UPDATE tags SET greader_sortid = nextval('greader_id_seq') WHERE greader_sortid IS NULL;
--> statement-breakpoint
ALTER TABLE tags ALTER COLUMN greader_sortid SET NOT NULL;
--> statement-breakpoint

-- users.greader_user_id — opaque user id / userProfileId; never reversed.
ALTER TABLE users ADD COLUMN greader_user_id bigint;
--> statement-breakpoint
ALTER TABLE users ALTER COLUMN greader_user_id SET DEFAULT nextval('greader_id_seq');
--> statement-breakpoint
UPDATE users SET greader_user_id = nextval('greader_id_seq') WHERE greader_user_id IS NULL;
--> statement-breakpoint
ALTER TABLE users ALTER COLUMN greader_user_id SET NOT NULL;
--> statement-breakpoint

-- Expose subscriptions.greader_stream_id on user_feeds (mirrors 0093 adding
-- unread_count) so the shared subscription query can serve the Google Reader
-- feed stream id + sortid.
DROP VIEW user_feeds;
--> statement-breakpoint
CREATE VIEW user_feeds AS
 SELECT s.id,
    s.user_id,
    s.subscribed_at,
    s.created_at,
    s.feed_id,
    s.custom_title,
    s.fetch_full_content,
    f.type,
    COALESCE(s.custom_title, f.title) AS title,
    f.title AS original_title,
    f.url,
    f.site_url,
    f.description,
    s.unread_count,
    s.greader_stream_id
   FROM (subscriptions s
     JOIN feeds f ON ((f.id = s.feed_id)))
  WHERE (s.unsubscribed_at IS NULL);
--> statement-breakpoint

-- Expose the entry's subscription stream id on visible_entries (from the
-- existing subscriptions join — no new join) so the Google Reader list path can
-- emit each item's origin stream id without deriving it from the UUID. Saved
-- entries (subscription_id NULL) get their saved-feed stream id from the feeds
-- join the entry-list query already performs.
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
    e.greader_item_id,
    s.greader_stream_id AS subscription_greader_stream_id
   FROM ((user_entries ue
     JOIN entries e ON ((e.id = ue.entry_id)))
     LEFT JOIN subscriptions s ON ((s.id = ue.subscription_id)))
  WHERE (((s.id IS NOT NULL) AND (s.unsubscribed_at IS NULL)) OR (ue.starred = true) OR (e.type = 'saved'::feed_type));
