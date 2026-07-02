-- Drop the dead ML-scoring tables and rebuild visible_entries without them (issue #953).
--
-- entry_score_predictions and user_score_models (and the users columns
-- algorithmic_feed_enabled / best_feed_score_weight / best_feed_uncertainty_weight)
-- have no Drizzle definition and no application code referencing them — the
-- entry-scoring feature was removed. Yet visible_entries still LEFT JOINed
-- entry_score_predictions on every entries query, paying a dead join on the
-- hottest path.
--
-- The rebuilt view also switches the visibility predicate from fail-open to
-- fail-closed: the old `s.unsubscribed_at IS NULL` evaluates TRUE when the
-- LEFT JOINs match no subscription at all, so an orphaned user_entries row
-- (no subscription_feeds/subscriptions match) was visible. The rule is
-- "active subscription OR starred OR saved article", so require one of those
-- explicitly. Saved articles live in a per-user feed with no subscription
-- row — for them the user_entries row alone is the visibility record (they
-- previously rode on the fail-open behavior).

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
    ue.score,
    ue.has_marked_read_on_list,
    ue.has_marked_unread,
    ue.has_starred,
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
    e.full_content_sanitized_version
   FROM (((user_entries ue
     JOIN entries e ON ((e.id = ue.entry_id)))
     LEFT JOIN subscription_feeds sf ON (((sf.user_id = ue.user_id) AND (sf.feed_id = e.feed_id))))
     LEFT JOIN subscriptions s ON ((s.id = sf.subscription_id)))
  WHERE (((s.id IS NOT NULL) AND (s.unsubscribed_at IS NULL)) OR (ue.starred = true) OR (e.type = 'saved'::feed_type));

--> statement-breakpoint

DROP TABLE entry_score_predictions;

--> statement-breakpoint

DROP TABLE user_score_models;

--> statement-breakpoint

ALTER TABLE users
  DROP COLUMN algorithmic_feed_enabled,
  DROP COLUMN best_feed_score_weight,
  DROP COLUMN best_feed_uncertainty_weight;
