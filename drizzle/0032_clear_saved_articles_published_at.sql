-- Clear published_at for saved articles so they sort by fetched_at (save time)
-- Saved articles should use fetchedAt for sorting, not the original article's publish date
-- COALESCE(published_at, fetched_at) will now return fetched_at for all saved articles

UPDATE entries
SET published_at = NULL, updated_at = NOW()
WHERE type = 'saved' AND published_at IS NOT NULL;
