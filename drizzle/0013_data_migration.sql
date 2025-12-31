-- Create saved feeds for users with existing saved_articles
INSERT INTO feeds (id, type, user_id, title, created_at, updated_at)
SELECT
  gen_uuidv7(),
  'saved',
  user_id,
  'Saved Articles',
  NOW(),
  NOW()
FROM (SELECT DISTINCT user_id FROM saved_articles) users
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Migrate saved_articles to entries
-- guid = url (the unique key for saved articles)
-- fetched_at = saved_at (when we acquired the article)
-- content_hash: use COALESCE to handle NULL values
INSERT INTO entries (
  id, feed_id, type, guid, url, title, author,
  content_original, content_cleaned, summary,
  site_name, image_url, content_hash,
  published_at, fetched_at, created_at, updated_at
)
SELECT
  sa.id,
  f.id,
  'saved',
  sa.url,  -- guid = url for saved articles
  sa.url,
  sa.title,
  sa.author,
  sa.content_original,
  sa.content_cleaned,
  sa.excerpt,  -- maps to summary
  sa.site_name,
  sa.image_url,
  COALESCE(sa.content_hash, ''),  -- handle NULL content_hash
  sa.saved_at,  -- published_at = when saved
  sa.saved_at,  -- fetched_at = when saved
  sa.created_at,
  sa.updated_at
FROM saved_articles sa
JOIN feeds f ON f.user_id = sa.user_id AND f.type = 'saved'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Create user_entries rows for migrated saved articles
INSERT INTO user_entries (user_id, entry_id, read, starred, read_at, starred_at)
SELECT
  sa.user_id,
  sa.id,  -- entry id = saved article id (preserved)
  sa.read,
  sa.starred,
  sa.read_at,
  sa.starred_at
FROM saved_articles sa
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Drop the saved_articles table
DROP TABLE "saved_articles" CASCADE;
