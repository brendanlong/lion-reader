-- Clear existing narration to fix paragraph mapping after adding standalone images to BLOCK_ELEMENTS
-- This ensures highlighting stays in sync with narration after the image processing fix
UPDATE narration_content
SET
  content_narration = NULL,
  paragraph_map = NULL,
  generated_at = NULL,
  error = NULL,
  error_at = NULL;
