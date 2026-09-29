-- Hard-deleted entries (saved articles), so delta-sync clients can drop their
-- local copies. Rows older than the sync horizon are pruned by the retention
-- job; a client whose deletions cursor is older than that must resync.

CREATE TABLE IF NOT EXISTS entry_tombstones (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entry_id)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_entry_tombstones_user_deleted_at ON entry_tombstones (user_id, deleted_at);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_entry_tombstones_deleted_at ON entry_tombstones (deleted_at);
