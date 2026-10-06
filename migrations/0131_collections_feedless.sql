-- Collections have no feed (#1846, phase 3B). Their type and name live on the
-- subscription, and they never held entries. The previous release creates
-- them without a feed; this removes the feed rows older collections (and any
-- created by the release before it during its rollout) still point at.
-- Adding the checks takes an ACCESS EXCLUSIVE lock on subscriptions and feeds,
-- both updated constantly (counter triggers, feed fetches), and validating
-- them scans both tables under that lock; the jobs delete scans jobs too. Take
-- both locks up front, so no later lock upgrade can deadlock, and fail fast
-- rather than queue every write behind them.
SET LOCAL lock_timeout = '5s';
LOCK TABLE subscriptions, feeds IN ACCESS EXCLUSIVE MODE;

-- Deleting a feed cascades to its entries (and their user_entries), its
-- WebSub subscriptions and any subscription still pointing at it. Collection
-- feeds should have none of these; stop rather than delete anything if one
-- does.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM feeds f JOIN entries e ON e.feed_id = f.id WHERE f.type = 'collection'
  ) THEN
    RAISE EXCEPTION 'a collection feed has entries; not deleting collection feeds';
  END IF;
  IF EXISTS (
    SELECT 1 FROM feeds f JOIN websub_subscriptions w ON w.feed_id = f.id WHERE f.type = 'collection'
  ) THEN
    RAISE EXCEPTION 'a collection feed has a WebSub subscription; not deleting collection feeds';
  END IF;
  IF EXISTS (
    SELECT 1 FROM feeds f JOIN subscriptions s ON s.feed_id = f.id
    WHERE f.type = 'collection' AND s.type <> 'collection'
  ) THEN
    RAISE EXCEPTION 'a non-collection subscription points at a collection feed; not deleting collection feeds';
  END IF;
END $$;

-- No client-visible field changes (clients get the subscription id as the
-- feed id), so updated_at stays put and delta sync doesn't re-deliver them.
UPDATE subscriptions SET feed_id = NULL WHERE type = 'collection' AND feed_id IS NOT NULL;

-- Jobs name feeds only in their payload, without a foreign key.
DELETE FROM jobs j USING feeds f
WHERE f.type = 'collection' AND j.payload->>'feedId' = f.id::text;

DELETE FROM feeds WHERE type = 'collection';

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_collection_feedless CHECK (type <> 'collection' OR feed_id IS NULL);

-- A feed is never a collection; the enum keeps the value for subscriptions.type.
ALTER TABLE feeds DROP CONSTRAINT feed_type_user_id;
ALTER TABLE feeds
  ADD CONSTRAINT feed_type_user_id CHECK ((type IN ('email', 'saved')) = (user_id IS NOT NULL)),
  ADD CONSTRAINT feeds_type_not_collection CHECK (type <> 'collection');

-- Every insert sets subscriptions.type (since phase 1), and the trigger
-- couldn't fill it for a subscription without a feed anyway.
DROP TRIGGER IF EXISTS subscriptions_fill_type_trigger ON subscriptions;
DROP FUNCTION IF EXISTS subscriptions_fill_type();
