-- A feed's site URL is only ever an http(s) URL, as for entry links (0189).
-- feeds is small, so the constraint and the cleanup share one migration.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  ALTER TABLE feeds
    ADD CONSTRAINT feeds_site_url_http
      CHECK (site_url ~* '^https?://[^\x01-\x20\x7f"<>]*$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
UPDATE feeds SET site_url = NULL WHERE site_url !~* '^https?://[^\x01-\x20\x7f"<>]*$';
