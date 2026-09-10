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
 * Anything beyond the lowercase scheme stays distinct: a guid without a scheme
 * never matches one with a scheme, and host/path differences are real
 * differences (planet feeds legitimately carry `http://a/?p=1` and
 * `http://b/?p=1`). Falling back to the permalink for feeds that genuinely
 * rotate guids is deliberately not attempted: it collapses link blogs, digest
 * feeds and podcast feeds whose every item links to the show page, and a
 * single-item WebSub push can't tell a rotation from a coexisting sibling.
 */

/**
 * Regex source shared by the TS and SQL forms so they can't drift. Case
 * sensitive on purpose: `guidMatchCandidates` enumerates spellings for an
 * exact-value lookup, so the key must fold only what it can enumerate.
 */
const GUID_SCHEME_PATTERN = "^https?://";

const GUID_SCHEME_REGEX = new RegExp(GUID_SCHEME_PATTERN);

/**
 * The key two guids are compared on: the guid with an http/https scheme
 * canonicalized to `https://`. Must stay equivalent to `canonicalGuidSql`.
 */
export function canonicalGuid(guid: string): string {
  return guid.replace(GUID_SCHEME_REGEX, "https://");
}

/**
 * SQL expression computing `canonicalGuid` for a column reference, for use in
 * raw queries that compare guids across rows. `columnRef` must be a literal
 * column reference from the calling query, never user input.
 */
export function canonicalGuidSql(columnRef: string): string {
  return `regexp_replace(${columnRef}, '${GUID_SCHEME_PATTERN}', 'https://')`;
}

/**
 * Every stored guid spelling that shares the incoming guid's `canonicalGuid`
 * key, for an exact-value lookup on the (feed_id, guid) unique index — cheaper
 * than an expression scan over the feed's entries.
 */
export function guidMatchCandidates(guid: string): string[] {
  if (!GUID_SCHEME_REGEX.test(guid)) {
    return [guid];
  }
  const rest = guid.replace(GUID_SCHEME_REGEX, "");
  return [`http://${rest}`, `https://${rest}`];
}
