-- Drop plain indexes whose column is the leading column of an existing
-- unique key / primary key on the same table, which already serves those
-- lookups (same rationale as 0076). IF EXISTS so the migration is a no-op on
-- a database where they were dropped by hand.

DROP INDEX IF EXISTS idx_subscription_tags_subscription; -- prefix of subscription_tags_subscription_id_tag_id_pk

--> statement-breakpoint

DROP INDEX IF EXISTS idx_websub_feed; -- prefix of uq_websub_subscriptions_feed_hub

--> statement-breakpoint

DROP INDEX IF EXISTS idx_oauth_consent_grants_user; -- prefix of oauth_consent_grants_user_id_client_id_key
