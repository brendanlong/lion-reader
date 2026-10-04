-- Unsubscribing clears a subscription's tags, but the feed-redirect merge left
-- them on the subscriptions it soft-deleted, inflating tags' feed counts (#1543).
DELETE FROM subscription_tags st
USING subscriptions s
WHERE s.id = st.subscription_id
  AND s.unsubscribed_at IS NOT NULL;
