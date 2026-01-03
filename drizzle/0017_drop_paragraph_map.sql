-- Drop paragraph_map column from narration_content
-- This column is no longer used since narration now uses 1:1 paragraph mapping
-- (narration paragraph N always maps to original paragraph N)

ALTER TABLE "narration_content" DROP COLUMN IF EXISTS "paragraph_map";
