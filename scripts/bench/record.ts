/**
 * The statements an app function sends, recorded by running it once against
 * the benchmark database, so a benchmark measures the app's own SQL and can't
 * drift from it. It runs through the app's pool (`@/server/db`), so the
 * driver settings (timestamp parsing) are the app's too.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { dbConfig, pool, type Database } from "@/server/db";
import type { Statement } from "./benchmarks";

/**
 * Runs `fn` and returns every query it sent, labelled `label.0`, `label.1`, …
 * in SQL order: functions that run queries in parallel start them in an order
 * that can differ between runs, and each label must name the same statement in
 * every run so results can be compared statement by statement.
 */
export async function recordStatements(
  label: string,
  fn: (db: Database) => Promise<unknown>
): Promise<Statement[]> {
  const sent: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle(pool, {
    ...dbConfig,
    logger: { logQuery: (sql, params) => sent.push({ sql, params }) },
  });
  await fn(db);
  return sent
    .sort((a, b) => a.sql.localeCompare(b.sql))
    .map((s, i) => ({ label: `${label}.${i}`, ...s }));
}

/** Closes the app's pool (`@/server/db`), so the process can exit. */
export async function closeRecording(): Promise<void> {
  await pool.end();
}
