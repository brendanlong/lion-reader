-- OPML imports table for async background import processing
-- Allows returning immediately to the user while processing feeds in the background

CREATE TABLE "opml_imports" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'pending',
  "total_feeds" integer NOT NULL,
  "imported_count" integer NOT NULL DEFAULT 0,
  "skipped_count" integer NOT NULL DEFAULT 0,
  "failed_count" integer NOT NULL DEFAULT 0,
  "feeds_data" jsonb NOT NULL,
  "results" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone
);--> statement-breakpoint

-- Index for listing imports by user
CREATE INDEX "idx_opml_imports_user" ON "opml_imports" USING btree ("user_id");--> statement-breakpoint

-- Index for finding pending imports (for job polling)
CREATE INDEX "idx_opml_imports_status" ON "opml_imports" USING btree ("status");
