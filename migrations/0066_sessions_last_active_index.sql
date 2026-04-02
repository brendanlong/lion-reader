-- Add partial index on sessions.last_active_at for active (non-revoked) sessions.
-- Used by admin overview queries to efficiently count active users in time windows.
CREATE INDEX CONCURRENTLY idx_sessions_last_active
  ON sessions (last_active_at)
  WHERE revoked_at IS NULL;
