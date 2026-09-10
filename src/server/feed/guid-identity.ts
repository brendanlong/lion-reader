/**
 * Scheme-insensitive entry identity (issue #1535).
 *
 * Entries are keyed on (feed_id, guid), but the same article can arrive under
 * `http://…` from one path and `https://…` from another: WordPress.com serves
 * `http://site/?p=N` guids in its polled feed while its WebSub hub pushes the
 * `https://` form, and some hosts flip the scheme between polls. Treating those
 * as different articles duplicates every post once and turns each edit into a
 * "new" article. So matching ignores the http/https scheme — and only that.
 * The stored guid is never rewritten: a stale scheme on a guid is normal
 * (WordPress keeps the guid a post was born with), and the row's identity is
 * exposed through the compat APIs.
 *
 * Anything beyond the scheme stays distinct: a guid without a scheme never
 * matches one with a scheme, and host/path differences are real differences
 * (planet feeds legitimately carry `http://a/?p=1` and `http://b/?p=1`).
 */

/** Regex source shared by the TS and SQL forms so they can't drift. */
export const GUID_SCHEME_PATTERN = "^https?://";

const GUID_SCHEME_REGEX = new RegExp(GUID_SCHEME_PATTERN, "i");

/**
 * The key two guids are compared on: the guid with an http/https scheme
 * canonicalized to `https://`. Must stay equivalent to `canonicalGuidSql`.
 */
export function canonicalGuid(guid: string): string {
  return guid.replace(GUID_SCHEME_REGEX, "https://");
}

/**
 * SQL expression computing `canonicalGuid` for a column reference, for use in
 * raw queries that compare guids across rows.
 */
export function canonicalGuidSql(columnRef: string): string {
  return `regexp_replace(${columnRef}, '${GUID_SCHEME_PATTERN}', 'https://', 'i')`;
}

/**
 * The stored guid spellings an incoming guid may match, for an exact-value
 * lookup on the (feed_id, guid) unique index — cheaper than an expression scan
 * over the feed's entries. Covers the guid verbatim plus both lowercase schemes,
 * which is every spelling a real feed emits.
 */
export function guidMatchCandidates(guid: string): string[] {
  if (!GUID_SCHEME_REGEX.test(guid)) {
    return [guid];
  }
  const rest = guid.replace(GUID_SCHEME_REGEX, "");
  return [...new Set([guid, `http://${rest}`, `https://${rest}`])];
}
