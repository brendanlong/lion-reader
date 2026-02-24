CREATE TABLE "saved_articles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"site_name" text,
	"author" text,
	"image_url" text,
	"content_original" text,
	"content_cleaned" text,
	"excerpt" text,
	"read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"starred" boolean DEFAULT false NOT NULL,
	"starred_at" timestamp with time zone,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_saved_articles_user_url" UNIQUE("user_id","url")
);
--> statement-breakpoint
ALTER TABLE "saved_articles" ADD CONSTRAINT "saved_articles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_saved_articles_user" ON "saved_articles" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "idx_saved_articles_unread" ON "saved_articles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_saved_articles_starred" ON "saved_articles" USING btree ("user_id","starred_at");