ALTER TYPE "public"."feed_type" ADD VALUE 'email';--> statement-breakpoint
ALTER TYPE "public"."feed_type" ADD VALUE 'saved';--> statement-breakpoint
CREATE TABLE "blocked_senders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"sender_email" text NOT NULL,
	"blocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"list_unsubscribe_mailto" text,
	"unsubscribe_sent_at" timestamp with time zone,
	CONSTRAINT "uq_blocked_senders_user_email" UNIQUE("user_id","sender_email")
);
--> statement-breakpoint
CREATE TABLE "ingest_addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ingest_addresses_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "type" "feed_type";--> statement-breakpoint
UPDATE "entries" e SET "type" = f."type" FROM "feeds" f WHERE e."feed_id" = f."id";--> statement-breakpoint
ALTER TABLE "entries" ALTER COLUMN "type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "site_name" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "spam_score" real;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "is_spam" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "list_unsubscribe_mailto" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "list_unsubscribe_https" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "list_unsubscribe_post" boolean;--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN "email_sender_pattern" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "show_spam" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "blocked_senders" ADD CONSTRAINT "blocked_senders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_addresses" ADD CONSTRAINT "ingest_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_blocked_senders_user" ON "blocked_senders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ingest_addresses_user" ON "ingest_addresses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ingest_addresses_token" ON "ingest_addresses" USING btree ("token");--> statement-breakpoint
ALTER TABLE "feeds" ADD CONSTRAINT "feeds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_entries_spam" ON "entries" USING btree ("feed_id","is_spam");--> statement-breakpoint
CREATE INDEX "idx_entries_type" ON "entries" USING btree ("type");--> statement-breakpoint
ALTER TABLE "feeds" ADD CONSTRAINT "uq_feeds_email_user_sender" UNIQUE("user_id","email_sender_pattern");--> statement-breakpoint
ALTER TABLE "feeds" ADD CONSTRAINT "feed_type_user_id" CHECK ((type IN ('email', 'saved')) = (user_id IS NOT NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_feeds_saved_user" ON "feeds" ("user_id") WHERE type = 'saved';--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_spam_only_email" CHECK (type = 'email' OR (spam_score IS NULL AND is_spam = false));--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_unsubscribe_only_email" CHECK (type = 'email' OR (list_unsubscribe_mailto IS NULL AND list_unsubscribe_https IS NULL AND list_unsubscribe_post IS NULL));--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_saved_metadata_only_saved" CHECK (type = 'saved' OR (site_name IS NULL AND image_url IS NULL));