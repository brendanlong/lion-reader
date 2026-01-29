-- Migration: Backfill has_starred for existing starred entries
--
-- The 0042_entry_scores migration added the has_starred column but didn't
-- backfill it for entries that were already starred. This migration sets
-- has_starred = true for all currently-starred entries.

UPDATE user_entries
SET has_starred = true
WHERE starred = true AND has_starred = false;
