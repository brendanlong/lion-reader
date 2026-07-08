/**
 * Postgres error helpers.
 */

/**
 * Postgres SQLSTATE for a unique-constraint violation.
 */
export const PG_UNIQUE_VIOLATION = "23505";

/**
 * Returns true if the error is a Postgres unique-constraint violation.
 * The `pg` driver surfaces the SQLSTATE on the error's `code` property, but
 * Drizzle wraps query errors and puts the original on `cause`, so we walk the
 * cause chain.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if ((current as { code?: unknown }).code === PG_UNIQUE_VIOLATION) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
