-- Lazy sanitization for the full-content family: clear eagerly-materialized
-- full_content_original_sanitized copies that are never served (issue #1117).
--
-- The full-content family's serving rule is strictly
-- `fullContentCleaned ?? fullContentOriginal` — there is no user-facing
-- original/cleaned toggle for full content (unlike the content family) — so a
-- sanitized copy of the whole raw fetched page is dead weight whenever
-- Readability produced cleaned content: ~403 MB of TOAST on prod, plus a
-- whole-page sanitize (tens of ms of CPU) on every full-content fetch and
-- every SANITIZER_VERSION bump. The write chokepoint
-- (withSanitizedEntryContent), the read-path heal, and the bulk re-sanitize
-- script now materialize full_content_original_sanitized only when
-- full_content_cleaned is NULL; this migration converges pre-existing rows to
-- the same shape. The extra full_content_cleaned_sanitized IS NOT NULL guard
-- means we never null a row's only sanitized copy (such a row heals from raw
-- on next read instead).
--
-- Deliberately sets ONLY this column — never updated_at. entries has no
-- triggers, so this is side-effect-free: no visible_entries.updated_at churn,
-- no delta-sync re-delivery, no SSE (same rule as the SANITIZER_VERSION
-- fast-forward guidance in CLAUDE.md).
--
-- Expand/contract: old code reading a nulled row serves
-- fullContentOriginal: NULL and every consumer already falls back to cleaned
-- (`fullContentCleaned ?? fullContentOriginal`), so this is backward
-- compatible. Old code writing during rollout may still eagerly materialize
-- the column on new/updated rows — harmless; the bulk re-sanitize script (or
-- a future sweep) can clear stragglers.
--
-- ~15k affected rows on prod; a single statement in one transaction is fine
-- for release_command. The freed TOAST space is reclaimed by autovacuum for
-- reuse (the file doesn't shrink).
UPDATE entries
SET full_content_original_sanitized = NULL
WHERE full_content_original_sanitized IS NOT NULL
  AND full_content_cleaned IS NOT NULL
  AND full_content_cleaned_sanitized IS NOT NULL;
