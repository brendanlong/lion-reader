-- Track the user-configurable settings used to generate each cached summary.
--
-- settingsChanged (summarization.generate) previously only compared the built-in
-- prompt version and model ID, so changing summarizationMaxWords or setting a
-- custom summarizationPrompt did not surface the "settings changed" indicator
-- that prompts regeneration (#824). Store what was used at generation time so we
-- have something to compare current settings against.
--
-- Nullable with no default so pre-existing rows read NULL and are treated as
-- "unknown" (never reported as changed), avoiding a spurious indicator on every
-- old summary.

ALTER TABLE entry_summaries ADD COLUMN max_words integer;

--> statement-breakpoint

ALTER TABLE entry_summaries ADD COLUMN prompt_hash text;
