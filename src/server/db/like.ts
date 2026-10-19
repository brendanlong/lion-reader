/**
 * A `LIKE`/`ILIKE` pattern matching `term` anywhere in the value. Escapes the
 * term's `%`, `_` and `\` (Postgres's default `LIKE` escape character), so a
 * user's search for "100%" or "a_b" matches that text instead of acting as a
 * wildcard. Every substring search over user input builds its pattern here.
 */
export function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}
