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
 * client having called `end()` — i.e. the far end hung up (`pg/lib/client.js`,
 * verified against pg 8.22). It carries no `code`, so the message is the only
 * thing to match on; if a future pg reworded it we would silently start
 * reporting these again, which is the safe direction to fail.
 *
 * The near-miss `"Connection terminated"` (pg's wording when *we* called `end()`)
 * is deliberately not matched: pg never emits it as an error.
 */
const PG_REMOTE_DISCONNECT_MESSAGE = "Connection terminated unexpectedly";

/**
 * Error codes that mean a pooled connection went away, rather than that a query
 * or the database is broken: socket teardown by the peer, plus Postgres
 * `admin_shutdown` (57P01) for a server restart.
 *
 * 57P01 also covers an operator's `pg_terminate_backend`, so this is a judgement
 * call — but on an idle connection it carries no information the DB's own logs
 * don't. The neighbouring shutdown codes are excluded on purpose: 57P02
 * (`crash_shutdown`) and 57P03 (`cannot_connect_now`) mean the database is in
 * trouble, not that one connection ended, and must still be reported.
 */
const DISCONNECT_CODES = new Set(["ECONNRESET", "EPIPE", "57P01"]);

/**
 * Returns true if the error just means "this connection went away".
 *
 * Used to keep routine disconnects out of Sentry (see `src/server/db/index.ts`).
 * Deliberately narrow: anything that isn't recognizably a disconnect is still
 * treated as a real error.
 *
 * Takes a raw `pg` error, as delivered to `pool.on("error")`. Unlike
 * `isUniqueViolation` it does NOT walk the `cause` chain, because a Drizzle-
 * wrapped error means a query failed and its caller is reporting it.
 */
export function isDisconnectError(error: Error): boolean {
  if (error.message === PG_REMOTE_DISCONNECT_MESSAGE) {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && DISCONNECT_CODES.has(code);
}
