-- Normalize saved article URLs by stripping fragments (#...).
-- Two URLs differing only by fragment point to the same article.

-- Step 1: Delete duplicate entries that would result after normalization.
-- Keep the entry with the earliest created_at (oldest saved first).
-- This handles cases like a user saving both example.com/page and example.com/page#section
DELETE FROM entries e
WHERE e.type = 'saved'
  AND e.url LIKE '%#%'
  AND EXISTS (
    -- Check if there's an older entry with the same normalized URL
    SELECT 1 FROM entries e2
    WHERE e2.feed_id = e.feed_id
      AND e2.type = 'saved'
      AND e2.id != e.id
      AND split_part(e2.url, '#', 1) = split_part(e.url, '#', 1)
      AND e2.created_at < e.created_at
  );
--> statement-breakpoint

-- Step 2: Strip fragments from remaining saved article URLs
UPDATE entries
SET
  url = split_part(url, '#', 1),
  guid = split_part(guid, '#', 1),
  updated_at = NOW()
WHERE type = 'saved'
  AND url LIKE '%#%';
