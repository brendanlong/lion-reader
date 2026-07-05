-- Stop soft-deleted tags from permanently blocking name reuse (issue #952).
--
-- tags uses soft delete (deleted_at) for sync tracking, but uq_tags_user_name was
-- a plain UNIQUE (user_id, name) covering deleted rows too. So "News" → delete →
-- "News" hit a unique violation the UI surfaced as an inexplicable "a tag with
-- this name already exists", and renaming onto a previously-deleted name failed
-- the same way. Making the uniqueness partial on deleted_at IS NULL scopes it to
-- live tags, so a tombstoned name can be reused; multiple tombstones may now
-- share a name, which is fine.
--
-- Replace the constraint with a partial unique index of the same name. Existing
-- data already satisfies it (the old constraint was strictly stricter).

ALTER TABLE public.tags DROP CONSTRAINT uq_tags_user_name;

--> statement-breakpoint

CREATE UNIQUE INDEX uq_tags_user_name
  ON public.tags (user_id, name)
  WHERE deleted_at IS NULL;
