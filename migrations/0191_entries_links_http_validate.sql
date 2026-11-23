-- Validates 0190's constraints over the existing rows (all valid since 0189).
-- VALIDATE takes only a SHARE UPDATE EXCLUSIVE lock: reads and writes go on.
ALTER TABLE entries VALIDATE CONSTRAINT entries_url_http;
--> statement-breakpoint
ALTER TABLE entries VALIDATE CONSTRAINT entries_image_url_http;
--> statement-breakpoint
ALTER TABLE entries VALIDATE CONSTRAINT entries_unsubscribe_url_http;
--> statement-breakpoint
ALTER TABLE entries VALIDATE CONSTRAINT entries_list_unsubscribe_https_http;
