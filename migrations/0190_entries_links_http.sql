-- Stored entry links are only ever http(s) URLs a client can't parse
-- differently; 0189 cleared the rest. NOT VALID so adding them doesn't scan the
-- table under an exclusive lock; 0191 validates them without one. Each is
-- guarded on its own, so one that already exists doesn't skip the others.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  ALTER TABLE entries ADD CONSTRAINT entries_url_http CHECK (url ~* '^https?://[^\x01-\x20\x7f"<>]*$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE entries ADD CONSTRAINT entries_image_url_http CHECK (image_url ~* '^https?://[^\x01-\x20\x7f"<>]*$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE entries ADD CONSTRAINT entries_unsubscribe_url_http CHECK (unsubscribe_url ~* '^https?://[^\x01-\x20\x7f"<>]*$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE entries ADD CONSTRAINT entries_list_unsubscribe_https_http CHECK (list_unsubscribe_https ~* '^https?://[^\x01-\x20\x7f"<>]*$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
