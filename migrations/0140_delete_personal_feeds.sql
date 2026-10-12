-- Step 3 of 4 (see 0138): delete the email and saved feeds. An email is owned
-- only by its subscription and a saved article only by its user; feeds hold
-- web feeds only, and only web subscriptions have one.
--
-- Deleting a feed cascades to the entries, subscriptions and WebSub
-- subscriptions naming it, so this aborts, rather than cascading, if anything
-- but what it clears here still names an email or saved feed.
SET LOCAL lock_timeout = '5s';
-- The previous release's writes touch feeds before entries and subscriptions.
LOCK TABLE feeds, entries, subscriptions IN ACCESS EXCLUSIVE MODE;

-- Emails the previous release wrote since 0139 still copy their
-- subscription's feed (cleared below); 0139 checked the owners of the rest.
UPDATE entries SET owner_feed_id = NULL
WHERE owner_feed_id IN (SELECT id FROM feeds WHERE type <> 'web')
  AND type IN ('email', 'saved');

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM entries
  WHERE owner_feed_id IN (SELECT id FROM feeds WHERE type <> 'web');
  IF n > 0 THEN
    RAISE EXCEPTION '0140: % web entries name an email or saved feed', n;
  END IF;

  SELECT count(*) INTO n FROM websub_subscriptions w
  JOIN feeds f ON f.id = w.feed_id WHERE f.type <> 'web';
  IF n > 0 THEN
    RAISE EXCEPTION '0140: % websub_subscriptions name an email or saved feed', n;
  END IF;

  SELECT count(*) INTO n FROM jobs j
  JOIN feeds f ON f.id::text = j.payload->>'feedId' WHERE f.type <> 'web';
  IF n > 0 THEN
    RAISE EXCEPTION '0140: % jobs name an email or saved feed', n;
  END IF;

  -- The only subscription to an email feed is its user's email subscription
  -- to that sender; saved feeds have none.
  SELECT count(*) INTO n FROM subscriptions s
  JOIN feeds f ON f.id = s.feed_id
  WHERE f.type <> 'web'
    AND NOT (f.type = 'email' AND s.type = 'email' AND s.user_id = f.user_id
             AND s.email_sender IS NOT DISTINCT FROM f.email_sender_pattern);
  IF n > 0 THEN
    RAISE EXCEPTION '0140: % subscriptions name an email or saved feed other than as its email subscription', n;
  END IF;
END $$;

-- An email subscription keeps its name (its feed's title) itself, like a
-- collection. The title shown doesn't change, so updated_at doesn't move.
UPDATE subscriptions s
SET feed_id = NULL, custom_title = COALESCE(s.custom_title, f.title, s.email_sender)
FROM feeds f
WHERE f.id = s.feed_id AND s.type = 'email';

-- Nothing names them now, so the cascades delete nothing.
DELETE FROM feeds WHERE type <> 'web';

ALTER TABLE entries ADD CONSTRAINT entries_owner_matches_type CHECK (
  (type = 'web') = (owner_feed_id IS NOT NULL)
  AND (type = 'email') = (owner_subscription_id IS NOT NULL)
  AND (type = 'saved') = (owner_user_id IS NOT NULL)
) NOT VALID;

ALTER TABLE subscriptions
  DROP CONSTRAINT subscriptions_collection_feedless,
  DROP CONSTRAINT subscriptions_saved_feedless,
  DROP CONSTRAINT subscriptions_collection_named,
  ADD CONSTRAINT subscriptions_feed_iff_web CHECK ((type = 'web') = (feed_id IS NOT NULL)),
  ADD CONSTRAINT subscriptions_named_unless_web CHECK (type = 'web' OR custom_title IS NOT NULL);

-- feeds.user_id and email_sender_pattern stay, always NULL, until no release
-- names them (#1846 phase 7).
ALTER TABLE feeds
  DROP CONSTRAINT feed_type_user_id,
  DROP CONSTRAINT feeds_type_not_collection,
  ADD CONSTRAINT feeds_web_only CHECK (type = 'web' AND user_id IS NULL AND email_sender_pattern IS NULL);
