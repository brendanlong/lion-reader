-- Merge web entries that differ only by the http/https scheme of their guid,
-- then forbid new ones (issue #1535).
--
-- WordPress.com serves `http://site/?p=N` guids in its polled feed while its
-- WebSub hub pushes the `https://` spelling, so the same post was stored twice.
-- Entry matching is now scheme-insensitive (src/server/feed/guid-identity.ts);
-- this migration collapses the twins that already exist and adds the unique
-- index that makes the rule a database invariant — including for a poll and a
-- push racing on one feed, which the lookup alone can't prevent.
--
-- Per group the oldest row survives (UUIDv7 ids order by creation). It takes
-- the newest twin's content, so an edit that arrived under the other spelling
-- is kept, the loser's full-content fetch if it has none of its own, and the
-- newest last_seen_at, so it stays in the feed's current generation. Per-user
-- state folds into the survivor's row: unread if any twin was unread, starred
-- if any was starred, and the latest change timestamps always advance (they
-- are the last-writer-wins watermarks for offline replays). A user who held
-- only a loser row gets it re-pointed, with the sort key recomputed for the
-- survivor. The user_entries counter triggers account for every step, so no
-- counter needs recomputing.
--
-- Expand/contract: the previous release matches guids exactly, so until the
-- canary finishes each poll of a merged feed retries the twin insert and hits
-- this index. That surfaces as a per-entry "Failed to process entry" log line
-- per poll and the new code then matches the existing row — the same outcome
-- the old code already had for an identical-guid race.
--
-- The unique index is partial (web only): saved articles key on the normalized
-- URL and email entries on the Message-ID, where the scheme is meaningful or
-- absent. The build takes a SHARE lock on entries for its duration. To avoid
-- that on a large production table, run the merge statements by hand first
-- (a unique build fails while twins exist), then build the index CONCURRENTLY
-- by hand (see CLAUDE.md); the IF NOT EXISTS below then no-ops.
CREATE TEMP TABLE scheme_twin_losers AS
WITH groups AS (
  SELECT feed_id,
         regexp_replace(guid, '^https?://', 'https://') AS key,
         (array_agg(id ORDER BY id))[1] AS survivor_id
  FROM entries
  WHERE type = 'web'
  GROUP BY 1, 2
  HAVING count(*) > 1
)
SELECT g.survivor_id, e.id AS loser_id
FROM groups g
JOIN entries e
  ON e.feed_id = g.feed_id
 AND regexp_replace(e.guid, '^https?://', 'https://') = g.key
WHERE e.id <> g.survivor_id;
--> statement-breakpoint
UPDATE entries s
SET title = n.title,
    author = n.author,
    url = n.url,
    content_original = n.content_original,
    content_cleaned = n.content_cleaned,
    summary = n.summary,
    content_hash = n.content_hash,
    updated_at = n.updated_at
FROM (
  SELECT DISTINCT ON (l.survivor_id) l.survivor_id, e.*
  FROM scheme_twin_losers l
  JOIN entries e ON e.id = l.loser_id
  ORDER BY l.survivor_id, e.updated_at DESC
) n
WHERE s.id = n.survivor_id
  AND n.updated_at > s.updated_at;
--> statement-breakpoint
UPDATE entries s
SET full_content_original = n.full_content_original,
    full_content_cleaned = n.full_content_cleaned,
    full_content_hash = n.full_content_hash,
    full_content_fetched_at = n.full_content_fetched_at,
    full_content_error = n.full_content_error
FROM (
  SELECT DISTINCT ON (l.survivor_id) l.survivor_id, e.*
  FROM scheme_twin_losers l
  JOIN entries e ON e.id = l.loser_id
  WHERE e.full_content_original IS NOT NULL
  ORDER BY l.survivor_id, e.full_content_fetched_at DESC NULLS LAST
) n
WHERE s.id = n.survivor_id
  AND s.full_content_original IS NULL;
--> statement-breakpoint
UPDATE entries s
SET last_seen_at = m.last_seen_at
FROM (
  SELECT l.survivor_id, max(e.last_seen_at) AS last_seen_at
  FROM scheme_twin_losers l
  JOIN entries e ON e.id = l.loser_id
  GROUP BY 1
) m
WHERE s.id = m.survivor_id
  AND (s.last_seen_at IS NULL OR s.last_seen_at < m.last_seen_at);
--> statement-breakpoint
UPDATE user_entries ue
SET entry_id = p.survivor_id,
    published_or_fetched_at = COALESCE(sv.published_at, sv.fetched_at),
    updated_at = now()
FROM (
  SELECT DISTINCT ON (ue.user_id, l.survivor_id) ue.user_id, l.survivor_id, ue.entry_id AS loser_id
  FROM user_entries ue
  JOIN scheme_twin_losers l ON l.loser_id = ue.entry_id
  WHERE NOT EXISTS (
    SELECT 1 FROM user_entries s WHERE s.user_id = ue.user_id AND s.entry_id = l.survivor_id
  )
  ORDER BY ue.user_id, l.survivor_id, ue.entry_id
) p
JOIN entries sv ON sv.id = p.survivor_id
WHERE ue.user_id = p.user_id
  AND ue.entry_id = p.loser_id;
--> statement-breakpoint
UPDATE user_entries s
SET read = s.read AND f.all_read,
    starred = s.starred OR f.any_starred,
    read_changed_at = GREATEST(s.read_changed_at, f.read_changed_at),
    starred_changed_at = GREATEST(s.starred_changed_at, f.starred_changed_at),
    updated_at = CASE
      WHEN (s.read AND NOT f.all_read) OR (NOT s.starred AND f.any_starred) THEN now()
      ELSE s.updated_at
    END
FROM (
  SELECT ue.user_id,
         l.survivor_id,
         bool_and(ue.read) AS all_read,
         bool_or(ue.starred) AS any_starred,
         max(ue.read_changed_at) AS read_changed_at,
         max(ue.starred_changed_at) AS starred_changed_at
  FROM user_entries ue
  JOIN scheme_twin_losers l ON l.loser_id = ue.entry_id
  GROUP BY 1, 2
) f
WHERE s.user_id = f.user_id
  AND s.entry_id = f.survivor_id;
--> statement-breakpoint
DELETE FROM user_entries ue
USING scheme_twin_losers l
WHERE ue.entry_id = l.loser_id;
--> statement-breakpoint
DELETE FROM entries e
USING scheme_twin_losers l
WHERE e.id = l.loser_id;
--> statement-breakpoint
DROP TABLE scheme_twin_losers;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_entries_feed_guid_canonical
  ON entries (feed_id, regexp_replace(guid, '^https?://', 'https://'))
  WHERE type = 'web';
