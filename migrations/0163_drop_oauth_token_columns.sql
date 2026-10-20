-- Scopes and resource live on the grant, and nothing has written these since
-- migration 0162's release (#2053).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- In the order a consent revoke cascades through them.
LOCK TABLE oauth_consent_grants, oauth_access_tokens, oauth_refresh_tokens IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE oauth_consent_grants DROP COLUMN revoked_at;
--> statement-breakpoint
ALTER TABLE oauth_access_tokens DROP COLUMN scopes, DROP COLUMN resource;
--> statement-breakpoint
ALTER TABLE oauth_refresh_tokens DROP COLUMN scopes, DROP COLUMN resource, DROP COLUMN replaced_by_id;
