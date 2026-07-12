-- Widen the subscription attribution index into a timeline index (issue #1117,
-- step 4B — junction reads move to user_entries.subscription_id).
--
-- The subscription-scoped queries that used to resolve through
-- subscription_feeds now filter/seek on user_entries.subscription_id directly:
-- the per-subscription newest-item seek (Google Reader unread-count), the
-- subscription/tag/uncategorized entry filters, and the merge-job re-stamp.
-- The composite (subscription_id, published_or_fetched_at DESC, entry_id DESC)
-- serves all of them — equality on the leading column covers everything the
-- old single-column index did, and the appended sort key lets per-subscription
-- newest-first scans (LATERAL LIMIT 1, subscription timelines) seek instead of
-- sort. Partial on subscription_id IS NOT NULL: saved/uploaded rows are never
-- looked up by subscription.

DROP INDEX idx_user_entries_subscription;

--> statement-breakpoint

CREATE INDEX idx_user_entries_subscription_timeline
  ON user_entries (subscription_id, published_or_fetched_at DESC, entry_id DESC)
  WHERE subscription_id IS NOT NULL;
