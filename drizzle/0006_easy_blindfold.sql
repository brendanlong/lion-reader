CREATE TABLE "narration_content" (
	"id" uuid PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"content_narration" text,
	"generated_at" timestamp with time zone,
	"error" text,
	"error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "narration_content_content_hash_unique" UNIQUE("content_hash")
);
--> statement-breakpoint
ALTER TABLE "saved_articles" ADD COLUMN "content_hash" text;--> statement-breakpoint
CREATE INDEX "idx_narration_needs_generation" ON "narration_content" USING btree ("id");