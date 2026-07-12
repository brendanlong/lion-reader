-- Drop the subscription_feeds junction table (issue #1117, step 4D — final).
--
-- Entry → subscription resolution now lives entirely on
-- user_entries.subscription_id: visibility (migration 0087), filters/counts,
-- fanout GUID dedup, sync, and Google Reader all read it; every insert path
-- stamps it (inline or via the user_entries_fill_denormalized trigger); and
-- the feed-merge job re-stamps rows to the surviving subscription.
--
-- Reads were removed in step 4B and writes in step 4C — both deployed — so no
-- running release touches this table and the drop is expand/contract-safe.
-- The DROP takes the primary key, both indexes, and all three foreign keys
-- with it.

DROP TABLE subscription_feeds;
