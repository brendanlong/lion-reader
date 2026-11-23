-- Stored entry links are only ever http(s) URLs a client can't parse
-- differently (no controls, spaces, quotes or angle brackets): the app stores
-- `linkableUrl`'s normalized href, and these keep a `javascript:` link from
-- reaching a client through any API. NOT VALID so adding them doesn't scan the
-- table; 0190 cleans existing rows, and new writes are checked from here.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  ALTER TABLE entries
    ADD CONSTRAINT entries_url_http
      CHECK (url ~* '^https?://[^\x01-\x20\x7f"<>]*$') NOT VALID,
    ADD CONSTRAINT entries_image_url_http
      CHECK (image_url ~* '^https?://[^\x01-\x20\x7f"<>]*$') NOT VALID,
    ADD CONSTRAINT entries_unsubscribe_url_http
      CHECK (unsubscribe_url ~* '^https?://[^\x01-\x20\x7f"<>]*$') NOT VALID,
    ADD CONSTRAINT entries_list_unsubscribe_https_http
      CHECK (list_unsubscribe_https ~* '^https?://[^\x01-\x20\x7f"<>]*$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
