-- Add index on sessions.last_active_at for admin overview active-user queries.
CREATE INDEX CONCURRENTLY idx_sessions_last_active
  ON sessions (last_active_at);
