-- Make users.email case-insensitive using citext
-- Email addresses are case-insensitive per RFC 5321
-- citext preserves original case but compares case-insensitively

ALTER TABLE users
  ALTER COLUMN email TYPE citext;
