-- Step 2 of 4 (see 0138): email and saved entries stop naming their per-user
-- feed. Only a row lock per entry, so reads go on; the rows aren't updated
-- in place (owner_feed_id is indexed), which costs about 30 kB of WAL each.
--
-- First checks, and aborts rather than leave an entry without an owner, that
-- every email is owned by the subscription to its feed and every saved
-- article by its feed's user, and that no web entry has another owner.
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM entries e
  JOIN feeds f ON f.id = e.owner_feed_id
  WHERE f.type <> 'web'
    AND NOT (
      (f.type = 'email' AND e.type = 'email' AND e.owner_user_id IS NULL
       AND EXISTS (SELECT 1 FROM subscriptions s
                   WHERE s.id = e.owner_subscription_id AND s.feed_id = f.id AND s.type = 'email'))
      OR (f.type = 'saved' AND e.type = 'saved' AND e.owner_subscription_id IS NULL
          AND e.owner_user_id IS NOT DISTINCT FROM f.user_id));
  IF n > 0 THEN
    RAISE EXCEPTION '0139: % entries name an email or saved feed without the matching owner', n;
  END IF;

  SELECT count(*) INTO n FROM entries e
  JOIN feeds f ON f.id = e.owner_feed_id
  WHERE e.type <> 'web' AND f.type = 'web';
  IF n > 0 THEN
    RAISE EXCEPTION '0139: % email or saved entries name a web feed', n;
  END IF;

  SELECT count(*) INTO n FROM entries
  WHERE type = 'web' AND (owner_subscription_id IS NOT NULL OR owner_user_id IS NOT NULL);
  IF n > 0 THEN
    RAISE EXCEPTION '0139: % web entries have an email or saved owner', n;
  END IF;
END $$;

UPDATE entries SET owner_feed_id = NULL
WHERE type IN ('email', 'saved') AND owner_feed_id IS NOT NULL;
