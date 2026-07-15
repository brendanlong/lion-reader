/**
 * Parse an `Authorization: Bearer <token>` header.
 *
 * Parsed with a single left-to-right whitespace scan rather than a regex like
 * `/^Bearer\s+(.+)$/i`. That regex is ambiguous — both `\s+` and `.+` can match
 * a space — so a crafted header (`Bearer` + many spaces + a char `.` can't
 * match, e.g. a newline) makes the backtracking engine run in quadratic time
 * (ReDoS, CWE-1333). This scan is linear.
 *
 * Semantics: the scheme is matched case-insensitively (per RFC 7235) and the
 * returned token is trimmed of surrounding whitespace. Returns null if the
 * header is absent, has no whitespace separator, the scheme isn't `Bearer`, or
 * the token is empty.
 */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  // A single `\s` with no quantifier can't backtrack, so this is O(n).
  const wsIdx = authHeader.search(/\s/);
  if (wsIdx === -1) return null;
  if (authHeader.slice(0, wsIdx).toLowerCase() !== "bearer") return null;
  return authHeader.slice(wsIdx + 1).trim() || null;
}
