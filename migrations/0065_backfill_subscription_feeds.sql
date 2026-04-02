-- Backfill missing subscription_feeds rows.
--
-- The email inbound processing (process-inbound.ts) created subscriptions
-- without inserting into subscription_feeds. Entry queries join through
-- subscription_feeds, so affected subscriptions showed unread counts in the
-- sidebar but returned no entries when clicked.

INSERT INTO public.subscription_feeds (subscription_id, feed_id, user_id)
SELECT s.id, s.feed_id, s.user_id
FROM public.subscriptions s
LEFT JOIN public.subscription_feeds sf
  ON sf.subscription_id = s.id AND sf.feed_id = s.feed_id
WHERE sf.subscription_id IS NULL
ON CONFLICT DO NOTHING;
