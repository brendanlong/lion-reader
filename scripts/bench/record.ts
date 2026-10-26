/**
 * The statements an app function sends, recorded by running it once against
 * the benchmark database, so a benchmark measures the app's own SQL and can't
 * drift from it. It runs on a connection from the app's pool (`@/server/db`),
 * so the driver settings (timestamp parsing) are the app's too.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { TransactionRollbackError } from "drizzle-orm";
import { dbConfig, pool, type Database } from "@/server/db";
import { closeRedisClient } from "@/server/redis";
import type { Statement } from "./benchmarks";

/** What drizzle sends to open, nest and end the transactions themselves. */
const TRANSACTION_CONTROL = /^\s*(begin|commit|rollback|savepoint|release)\b/i;

/**
 * Runs `fn` in a transaction that is always rolled back, and returns every
 * query it sent, labelled `label.0`, `label.1`, … in the order it sent them.
 * A transaction the function opens itself runs as a savepoint inside it, so
 * a write keeps none of what it writes. The transaction statements are left
 * out: `run.ts` wraps each write in its own. On one connection the queries
 * run in the order they were sent, which is the order a write's replay needs.
 *
 * Queries `fn` leaves running when it returns (a fire-and-forget publish's
 * reads) are part of what it sends, so the rollback waits for the connection
 * to go idle.
 *
 * Anything `fn` runs through the app's global `db` would escape the rollback
 * and the recording, so the pool refuses connections meanwhile: such a
 * function must take `db` instead.
 */
export async function recordStatements(
  label: string,
  fn: (db: Database) => Promise<unknown>
): Promise<Statement[]> {
  const sent: Array<{ sql: string; params: unknown[] }> = [];
  const client = await pool.connect();
  const query = client.query;
  let running = 0;
  client.query = ((...args: Parameters<typeof query>) => {
    running++;
    return (query.apply(client, args) as unknown as Promise<unknown>).finally(() => running--);
  }) as typeof query;
  const db = drizzle(client, {
    ...dbConfig,
    logger: { logQuery: (sql, params) => sent.push({ sql, params }) },
  });
  const connect = pool.connect;
  pool.connect = (() => {
    throw new Error(`${label}: recorded code used the app's global db; pass it the db it's given`);
  }) as typeof pool.connect;
  try {
    await db.transaction(async (tx) => {
      // A transaction is a database whose transactions are savepoints.
      await fn(tx as unknown as Database);
      // A query's continuation sends the next one before the next macrotask.
      do await new Promise((resolve) => setImmediate(resolve));
      while (running > 0);
      tx.rollback();
    });
  } catch (err) {
    if (!(err instanceof TransactionRollbackError)) throw err;
  } finally {
    pool.connect = connect;
    client.query = query;
    client.release();
  }
  return sent
    .filter((s) => !TRANSACTION_CONTROL.test(s.sql))
    .map((s, i) => ({ label: `${label}.${i}`, ...s }));
}

/** Closes the app's pool and Redis client (`@/server/db`, `@/server/redis`), so the process can exit. */
export async function closeRecording(): Promise<void> {
  await Promise.all([pool.end(), closeRedisClient()]);
}
