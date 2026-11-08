-- The redirect URIs a user approved a client for: consent to one doesn't
-- cover another, or a client could get a harmless URI approved and then
-- silently send codes to a different one it registered. Existing grants start
-- empty, so they re-prompt once.
ALTER TABLE oauth_consent_grants ADD COLUMN redirect_uris text[] NOT NULL DEFAULT '{}';
