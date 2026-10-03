-- A collection is a per-user feed the user fills by hand (#1806). Its own
-- migration because a new enum value can't be used in the transaction that
-- adds it.
ALTER TYPE "public"."feed_type" ADD VALUE IF NOT EXISTS 'collection';
