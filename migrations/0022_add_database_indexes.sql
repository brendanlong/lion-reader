-- Add missing database indexes for query optimization

-- Critical: Partial index for active subscriptions by user
-- Used in entries.list, entries.count, subscriptions.list, tags.list, etc.
CREATE INDEX "idx_subscriptions_user_active" ON "subscriptions" USING btree ("user_id") WHERE "unsubscribed_at" IS NULL;--> statement-breakpoint

-- Critical: Index for feeds owned by user (email/saved feeds)
-- Used in entries.list, entries.count, subscriptions.create
CREATE INDEX "idx_feeds_user_id" ON "feeds" USING btree ("user_id");--> statement-breakpoint

-- Critical: Composite index for entries filtered by feed and type
-- Used in entries.list, entries.count, entries.markAllRead
CREATE INDEX "idx_entries_feed_type" ON "entries" USING btree ("feed_id", "type");--> statement-breakpoint

-- Important: Partial index for active subscriptions by feed
-- Used for checking if feed has active subscribers
CREATE INDEX "idx_subscriptions_feed_active" ON "subscriptions" USING btree ("feed_id") WHERE "unsubscribed_at" IS NULL;--> statement-breakpoint

-- Important: Index for feed type filtering
-- Used in entries.list, entries.count for saved/email feeds
CREATE INDEX "idx_feeds_type" ON "feeds" USING btree ("type");--> statement-breakpoint

-- Important: Index for subscription tags reverse lookup
-- Used in subscriptions.setTags, subscriptions.get, subscriptions.update
CREATE INDEX "idx_subscription_tags_subscription" ON "subscription_tags" USING btree ("subscription_id");
