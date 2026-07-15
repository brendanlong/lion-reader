/**
 * Feature flags shared by client and server code.
 */

/**
 * Kill switch for entry full-text search (#1249).
 *
 * Search has no database index: every query seq-scans and tokenizes all of a
 * user's entry bodies (multiple seconds per search). The fix — a stored
 * tsvector column + GIN index — requires a full rewrite of the `entries`
 * table, deferred until the DB migration is finished. Until then search is
 * disabled end to end: the `?q=` URL param is ignored, the search UI and `/`
 * shortcut are hidden, `listEntries` rejects `query`, the MCP `list_entries`
 * tool no longer advertises it, and the Wallabag search endpoint returns an
 * error.
 *
 * Typed as `boolean` (not the literal `false`) so gated code isn't flagged as
 * unreachable. To re-enable: flip this to `true`, delete the flag and its call
 * sites, and restore the skipped tests listed in #1249.
 */
export const ENTRY_SEARCH_ENABLED: boolean = false;
