/**
 * Each integration worker gets its own Postgres database (a copy of the migrated
 * test database) and its own Redis logical DB, so files can run in parallel even
 * though they clean up with table-wide deletes and `flushdb()`.
 *
 * Redis pub/sub channels are shared across logical DBs, which is safe only because
 * every channel a test subscribes to is named by a fresh user or feed ID.
 */

export function workerDatabaseUrl(baseUrl: string, poolId: number): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname}_${poolId}`;
  return url.toString();
}

/** Logical DB 0 stays the dev default; workers use 1..maxWorkers. */
export function workerRedisUrl(baseUrl: string, poolId: number): string {
  const url = new URL(baseUrl);
  url.pathname = `/${poolId}`;
  return url.toString();
}
