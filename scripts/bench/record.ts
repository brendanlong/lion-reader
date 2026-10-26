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
 * out: `run.ts` wraps each write in its own. A write's replay runs the
 * statements in that order with the ids and times the recording generated,
 * which reproduces the work because the recording kept nothing; on one
 * connection the queries run in the order they were sent. A function that
 * recovers by rolling back to a savepoint can't be replayed, so it's refused.
 *
 * Queries `fn` leaves running when it returns (a fire-and-forget publish's
 * reads) are part of what it sends, so the rollback waits for the connection
 * to go idle; one sent later fails rather than run outside the transaction.
 *
 * Anything `fn` runs through the app's global `db` would escape the rollback
 * and the recording, so the pool refuses connections meanwhile, and the
 * recording fails even if the app catches that: such a function must take
 * `db` instead.
 */
export async function recordStatements(
  label: string,
  fn: (db: Database) => Promise<unknown>
): Promise<Statement[]> {
  const sent: Array<{ sql: string; params: unknown[] }> = [];
  const client = await pool.connect();
  const query = client.query;
  const running = new Set<Promise<unknown>>();
  client.query = ((...args: Parameters<typeof query>) => {
    const result = query.apply(client, args) as unknown as Promise<unknown>;
    running.add(result);
    const settled = () => void running.delete(result);
    result.then(settled, settled);
    return result;
  }) as typeof query;
  const db = drizzle(client, {
    ...dbConfig,
    logger: { logQuery: (sql, params) => sent.push({ sql, params }) },
  });
  const connect = pool.connect;
  let usedGlobalDb = false;
  pool.connect = (() => {
    usedGlobalDb = true;
    throw new Error(`${label}: recorded code used the app's global db`);
  }) as typeof pool.connect;
  try {
    await db.transaction(async (tx) => {
      // A transaction is a database whose transactions are savepoints.
      await fn(tx as unknown as Database);
      // A query's continuation sends the next one before the next macrotask.
      do {
        await Promise.allSettled(running);
        await new Promise((resolve) => setImmediate(resolve));
      } while (running.size > 0);
      tx.rollback();
    });
  } catch (err) {
    if (!(err instanceof TransactionRollbackError)) throw err;
  } finally {
    pool.connect = connect;
    client.query = (() => {
      throw new Error(`${label}: a query was sent after the recording ended`);
    }) as typeof query;
    client.release(true);
  }
  if (usedGlobalDb) {
    throw new Error(`${label}: recorded code used the app's global db; pass it the db it's given`);
  }
  if (sent.some((s) => /^\s*rollback to savepoint\b/i.test(s.sql))) {
    throw new Error(`${label}: rolled back to a savepoint, so its statements can't be replayed`);
  }
  return sent
    .filter((s) => !TRANSACTION_CONTROL.test(s.sql))
    .map((s, i) => ({ label: `${label}.${i}`, ...s }));
}

/** Closes the app's pool and Redis client (`@/server/db`, `@/server/redis`), so the process can exit. */
export async function closeRecording(): Promise<void> {
  await Promise.all([pool.end(), closeRedisClient()]);
}
