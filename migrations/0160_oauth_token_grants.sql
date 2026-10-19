-- One row per authorization (an authorization-code exchange or a Wallabag
-- password grant). Every access and refresh token minted from it, across all
-- rotations, points at it, and validation requires it unrevoked: revoking the
-- grant kills the whole chain, including a successor a racing rotation commits
-- afterwards (#2042).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE oauth_token_grants (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  scopes text[] NOT NULL,
  resource text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
--> statement-breakpoint
CREATE INDEX idx_oauth_token_grants_user_client ON oauth_token_grants (user_id, client_id);
--> statement-breakpoint
ALTER TABLE oauth_access_tokens ADD COLUMN grant_id uuid;
--> statement-breakpoint
ALTER TABLE oauth_refresh_tokens ADD COLUMN grant_id uuid;
--> statement-breakpoint

-- Backfill one grant per rotation chain, keyed by the chain's first refresh
-- token (rotation copies scopes and resource, so the first token's are the
-- chain's), then point every later token in the chain at it.
INSERT INTO oauth_token_grants (id, user_id, client_id, scopes, resource, created_at)
SELECT r.id, r.user_id, r.client_id, r.scopes, r.resource, r.created_at
FROM oauth_refresh_tokens r
WHERE NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens p WHERE p.replaced_by_id = r.id);
--> statement-breakpoint
WITH RECURSIVE chain (id, grant_id) AS (
  SELECT g.id, g.id FROM oauth_token_grants g
  UNION ALL
  SELECT p.replaced_by_id, c.grant_id
  FROM chain c
  JOIN oauth_refresh_tokens p ON p.id = c.id
  WHERE p.replaced_by_id IS NOT NULL
)
UPDATE oauth_refresh_tokens r SET grant_id = c.grant_id FROM chain c WHERE r.id = c.id;
--> statement-breakpoint
UPDATE oauth_access_tokens a
SET grant_id = r.grant_id
FROM oauth_refresh_tokens r
WHERE r.access_token_id = a.id;
--> statement-breakpoint

-- An access token whose refresh token is already gone gets a grant of its own.
INSERT INTO oauth_token_grants (id, user_id, client_id, scopes, resource, created_at)
SELECT a.id, a.user_id, a.client_id, a.scopes, a.resource, a.created_at
FROM oauth_access_tokens a
WHERE a.grant_id IS NULL;
--> statement-breakpoint
UPDATE oauth_access_tokens SET grant_id = id WHERE grant_id IS NULL;
--> statement-breakpoint

-- A chain with no live token left was already revoked or has run out; marking
-- it revoked keeps reuse detection from flagging a client that presents one of
-- its tokens.
UPDATE oauth_token_grants g
SET revoked_at = now()
WHERE NOT EXISTS (
    SELECT 1 FROM oauth_refresh_tokens r
    WHERE r.grant_id = g.id AND r.revoked_at IS NULL AND r.expires_at > now()
  )
  AND NOT EXISTS (
    SELECT 1 FROM oauth_access_tokens a
    WHERE a.grant_id = g.id AND a.revoked_at IS NULL AND a.expires_at > now()
  );
--> statement-breakpoint
ALTER TABLE oauth_access_tokens
  ALTER COLUMN grant_id SET NOT NULL,
  ADD CONSTRAINT oauth_access_tokens_grant_id_fkey
    FOREIGN KEY (grant_id) REFERENCES oauth_token_grants(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE oauth_refresh_tokens
  ALTER COLUMN grant_id SET NOT NULL,
  ADD CONSTRAINT oauth_refresh_tokens_grant_id_fkey
    FOREIGN KEY (grant_id) REFERENCES oauth_token_grants(id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX idx_oauth_access_tokens_grant ON oauth_access_tokens (grant_id);
--> statement-breakpoint
CREATE INDEX idx_oauth_refresh_tokens_grant ON oauth_refresh_tokens (grant_id);
--> statement-breakpoint

-- The previous release inserts tokens without a grant_id and links a rotation
-- only by stamping replaced_by_id on the predecessor. Until it's gone, these
-- triggers give its rows grants: a new access token gets a fresh grant, the
-- refresh token inserted with it joins that grant, and once a rotation stamps
-- replaced_by_id the successor pair moves into its predecessor's grant (the
-- emptied grant is left for retention). Dropped in #2053.
CREATE FUNCTION oauth_access_tokens_default_grant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.grant_id := uuidv7();
  INSERT INTO oauth_token_grants (id, user_id, client_id, scopes, resource)
  VALUES (NEW.grant_id, NEW.user_id, NEW.client_id, NEW.scopes, NEW.resource);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER oauth_access_tokens_default_grant_trigger
  BEFORE INSERT ON oauth_access_tokens
  FOR EACH ROW WHEN (NEW.grant_id IS NULL)
  EXECUTE FUNCTION oauth_access_tokens_default_grant();
--> statement-breakpoint
CREATE FUNCTION oauth_refresh_tokens_default_grant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.grant_id := (SELECT grant_id FROM oauth_access_tokens WHERE id = NEW.access_token_id);
  IF NEW.grant_id IS NULL THEN
    NEW.grant_id := uuidv7();
    INSERT INTO oauth_token_grants (id, user_id, client_id, scopes, resource)
    VALUES (NEW.grant_id, NEW.user_id, NEW.client_id, NEW.scopes, NEW.resource);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER oauth_refresh_tokens_default_grant_trigger
  BEFORE INSERT ON oauth_refresh_tokens
  FOR EACH ROW WHEN (NEW.grant_id IS NULL)
  EXECUTE FUNCTION oauth_refresh_tokens_default_grant();
--> statement-breakpoint
CREATE FUNCTION oauth_refresh_tokens_join_predecessor_grant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  successor_grant uuid;
  successor_access uuid;
BEGIN
  SELECT grant_id, access_token_id INTO successor_grant, successor_access
  FROM oauth_refresh_tokens WHERE id = NEW.replaced_by_id;
  IF successor_grant <> NEW.grant_id THEN
    UPDATE oauth_refresh_tokens SET grant_id = NEW.grant_id WHERE id = NEW.replaced_by_id;
    UPDATE oauth_access_tokens SET grant_id = NEW.grant_id WHERE id = successor_access;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER oauth_refresh_tokens_join_predecessor_grant_trigger
  AFTER UPDATE OF replaced_by_id ON oauth_refresh_tokens
  FOR EACH ROW WHEN (NEW.replaced_by_id IS NOT NULL AND NEW.replaced_by_id IS DISTINCT FROM OLD.replaced_by_id)
  EXECUTE FUNCTION oauth_refresh_tokens_join_predecessor_grant();
