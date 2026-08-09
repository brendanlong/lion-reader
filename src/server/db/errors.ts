/**
 * Postgres error helpers.
 */

/**
 * Postgres SQLSTATE for a unique-constraint violation.
 */
const PG_UNIQUE_VIOLATION = "23505";

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

/**
 * The exact message `pg` synthesizes when a client's socket closes without the
 * client having called `end()` — i.e. the far end hung up. It carries no `code`,
 * so the message is the only thing to match on (see `pg/lib/client.js`).
 */
const PG_REMOTE_DISCONNECT_MESSAGE = "Connection terminated unexpectedly";

/**
 * Error codes that mean a pooled connection went away, rather than that a query
 * or the database is broken: socket-level teardown plus Postgres `admin_shutdown`
 * (57P01), which is what a server restart or a `pg_terminate_backend` looks like.
 */
const DISCONNECT_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "57P01"]);

/**
 * Returns true if the error just means "this connection went away".
 *
 * Used to keep routine disconnects out of Sentry (see `src/server/db/index.ts`).
 * Deliberately narrow: anything that isn't recognizably a disconnect is still
 * treated as a real error.
 */
export function isDisconnectError(error: Error): boolean {
  if (error.message === PG_REMOTE_DISCONNECT_MESSAGE) {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && DISCONNECT_CODES.has(code);
}
