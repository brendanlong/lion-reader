-- Denormalize last-active tracking onto users (admin user list "Last active").
--
-- The admin user list derived "Last active" from MAX(sessions.last_active_at),
-- but the daily retention cleanup (0075) deletes sessions ~1 day after they
-- expire. Since sessions live 30 days from creation, any user inactive longer
-- than that lost every session row and showed as "Never" — the activity history
-- the admin page relied on was being cleaned up out from under it.
--
-- Store last_active_at on the user row so it survives session cleanup, backfill
-- from any surviving sessions, and index it for the admin activity sort.

ALTER TABLE users ADD COLUMN last_active_at timestamp with time zone;

--> statement-breakpoint

UPDATE users u
SET last_active_at = s.max_last_active
FROM (
  SELECT user_id, MAX(last_active_at) AS max_last_active
  FROM sessions
  GROUP BY user_id
) s
WHERE s.user_id = u.id;

--> statement-breakpoint

-- Supports ORDER BY last_active_at DESC NULLS LAST, id DESC (admin activity sort).
CREATE INDEX idx_users_last_active_at ON users (last_active_at DESC NULLS LAST, id DESC);
