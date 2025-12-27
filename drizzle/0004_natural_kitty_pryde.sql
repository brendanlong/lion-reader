CREATE TYPE "public"."websub_state" AS ENUM('pending', 'active', 'unsubscribed');--> statement-breakpoint
CREATE TABLE "websub_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"feed_id" uuid NOT NULL,
	"hub_url" text NOT NULL,
	"topic_url" text NOT NULL,
	"callback_secret" text NOT NULL,
	"state" "websub_state" DEFAULT 'pending' NOT NULL,
	"lease_seconds" integer,
	"expires_at" timestamp with time zone,
	"last_challenge_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_websub_subscriptions_feed_hub" UNIQUE("feed_id","hub_url")
);
--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN "hub_url" text;--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN "self_url" text;--> statement-breakpoint
ALTER TABLE "feeds" ADD COLUMN "websub_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "websub_subscriptions" ADD CONSTRAINT "websub_subscriptions_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_websub_expiring" ON "websub_subscriptions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_websub_feed" ON "websub_subscriptions" USING btree ("feed_id");