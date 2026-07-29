-- Which narration format a cached row was generated with (issue #1451).
--
-- The stored paragraph map numbers elements the way the narration walk numbered
-- them at generation time, so a row from an older format highlights the wrong
-- paragraphs against today's `data-para-id`s. Rows whose version doesn't match
-- `NARRATION_FORMAT_VERSION` are treated as cache misses and regenerated in
-- place; existing rows (NULL) therefore regenerate once.
ALTER TABLE narration_content ADD COLUMN IF NOT EXISTS format_version integer;
