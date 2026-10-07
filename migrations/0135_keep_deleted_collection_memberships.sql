-- Deleting a collection is the same soft delete as unsubscribing a feed
-- (#1846): its memberships stay and stop counting. The previous release
-- (phase 5A) reads collection memberships only for active collections, so it
-- doesn't rely on the emptying this trigger did.
DROP TRIGGER subscriptions_empty_unsubscribed_collection_trigger ON subscriptions;
DROP FUNCTION subscriptions_empty_unsubscribed_collection();
