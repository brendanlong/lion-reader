-- Switch TOAST compression from pglz (the default) to lz4 on the large
-- content columns (issue #1117).
--
-- Database CPU is far more expensive than storage for this project. The
-- per-column size audit on prod (issue #1117) showed entry content is ~96%
-- of the 4.2 GB database, and pglz compress/decompress of these TOASTed
-- values is suspected to be a major share of DB CPU on content reads/writes
-- (DB CPU cost is what forced removal of the background resanitize job in
-- issue #1116). lz4 is roughly an order of magnitude faster than pglz in
-- both directions at a slightly worse compression ratio (~few % larger) —
-- the right trade here.
--
-- SET COMPRESSION is a catalog-only change: instant, no table rewrite, brief
-- ACCESS EXCLUSIVE lock — safe in the Fly release_command migration step. It
-- affects only newly written values; existing TOAST values stay pglz until
-- their row's column is rewritten (e.g. by the upcoming sanitized-column
-- rewrites planned in #1117 step 7). Decompression of old pglz values keeps
-- working forever regardless.
--
-- Expand/contract: trivially backward compatible — old code is unaffected by
-- the compression method. Requires the server to be built with lz4 support
-- (--with-lz4, standard in Debian/most distro builds, Postgres >= 14); the
-- migration fails loudly at release time if unsupported.

ALTER TABLE entries
  ALTER COLUMN content_original SET COMPRESSION lz4,
  ALTER COLUMN content_cleaned SET COMPRESSION lz4,
  ALTER COLUMN content_original_sanitized SET COMPRESSION lz4,
  ALTER COLUMN content_cleaned_sanitized SET COMPRESSION lz4,
  ALTER COLUMN full_content_original SET COMPRESSION lz4,
  ALTER COLUMN full_content_cleaned SET COMPRESSION lz4,
  ALTER COLUMN full_content_original_sanitized SET COMPRESSION lz4,
  ALTER COLUMN full_content_cleaned_sanitized SET COMPRESSION lz4,
  ALTER COLUMN summary SET COMPRESSION lz4;

--> statement-breakpoint

ALTER TABLE narration_content
  ALTER COLUMN content_narration SET COMPRESSION lz4;

--> statement-breakpoint

ALTER TABLE entry_summaries
  ALTER COLUMN summary_text SET COMPRESSION lz4;
