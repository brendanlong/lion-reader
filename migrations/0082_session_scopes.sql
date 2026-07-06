-- Scoped sessions: let a session carry a restricted set of scopes instead of
-- being full-access.
--
-- Sessions were always full browser-equivalent access. The Google Reader compat
-- API mints a real session via ClientLogin, so a leaked Google Reader token
-- could be replayed as a browser session cookie for full account access
-- (change password, delete account). Adding a nullable scopes column lets
-- ClientLogin mint a session restricted to reader:full-access.
--
-- NULL scopes = full access (a normal browser login) — the fail-closed default,
-- and what every existing session becomes. A non-NULL array marks the session
-- as restricted; validateSession rejects such sessions for full-access use
-- unless the caller explicitly opts in (only the Google Reader API does).
--
-- Expand-safe: the column is nullable with no default, so existing rows and old
-- code (which never sets or reads it) are unaffected.

ALTER TABLE public.sessions ADD COLUMN scopes text[];
