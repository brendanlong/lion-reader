-- The previous release (#2042) gives every token a grant, revokes by deleting,
-- and reads scopes and resource from the grant, so the triggers that adapted
-- the release before it go (#2053). Token rows stop getting scopes; the
-- columns, replaced_by_id and the consent revoked_at are dropped next release.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- In the order a consent revoke cascades through them.
LOCK TABLE oauth_consent_grants, oauth_access_tokens, oauth_refresh_tokens IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DROP TRIGGER oauth_access_tokens_default_grant_trigger ON oauth_access_tokens;
--> statement-breakpoint
DROP TRIGGER oauth_refresh_tokens_default_grant_trigger ON oauth_refresh_tokens;
--> statement-breakpoint
DROP TRIGGER oauth_refresh_tokens_join_predecessor_grant_trigger ON oauth_refresh_tokens;
--> statement-breakpoint
DROP TRIGGER oauth_consent_grants_delete_revoked_trigger ON oauth_consent_grants;
--> statement-breakpoint
DROP FUNCTION oauth_access_tokens_default_grant();
--> statement-breakpoint
DROP FUNCTION oauth_refresh_tokens_default_grant();
--> statement-breakpoint
DROP FUNCTION oauth_refresh_tokens_join_predecessor_grant();
--> statement-breakpoint
DROP FUNCTION oauth_new_token_grant(uuid, text, text[], text);
--> statement-breakpoint
DROP FUNCTION oauth_consent_grants_delete_revoked();
--> statement-breakpoint
ALTER TABLE oauth_access_tokens ALTER COLUMN scopes DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE oauth_refresh_tokens ALTER COLUMN scopes DROP NOT NULL;
