-- Persist the narration paragraph map alongside the cached narration text.
--
-- The paragraph map translates a narration paragraph index (what the TTS player
-- reports as it speaks) into the `data-para-id` of the block element to
-- highlight. It used to be reconstructed on every cache hit by positionally
-- pairing the source's block elements with the cached narration's paragraphs —
-- which silently mis-mapped whenever the LLM dropped a paragraph or a block's
-- narration text spanned multiple paragraphs, shifting every subsequent
-- highlight onto the wrong element.
--
-- Storing the map that generation actually produced makes cache hits return the
-- correct alignment. Nullable + no default: existing rows keep NULL and the read
-- path re-derives a best-effort map from the source content until they're
-- regenerated. Expand-only, backward compatible (old code ignores the column).

ALTER TABLE narration_content
  ADD COLUMN paragraph_map jsonb;
