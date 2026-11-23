-- A feed's site URL is only ever an http(s) URL, as for entry links (0190).
-- feeds is small, so the constraint is checked as it's added.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  ALTER TABLE feeds ADD CONSTRAINT feeds_site_url_http CHECK (site_url ~* '^https?://[^\x01-\x20\x7f"<>]*$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
