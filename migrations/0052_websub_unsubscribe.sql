-- Add unsubscribe_requested_at column to websub_subscriptions table.
-- Tracks when we've requested an unsubscribe from a hub, so we can
-- confirm unsubscribe verification callbacks per W3C WebSub spec Section 5.3.

ALTER TABLE websub_subscriptions ADD COLUMN unsubscribe_requested_at timestamp with time zone;
