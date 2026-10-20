/**
 * The statements an app function sends, recorded by running it once against
 * the benchmark database, so a benchmark measures the app's own SQL and can't
 * drift from it. It runs through the app's pool (`@/server/db`), so the
 * driver settings (timestamp parsing) are the app's too.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { pool, type Database } from "@/server/db";
import * as schema from "@/server/db/schema";
import type { Statement } from "./benchmarks";

/**
 * Runs `fn` and returns every query it sent, labelled `label.0`, `label.1`, …
 * in the order they started. Functions that run queries in parallel can start
 * them in a different order between runs; a benchmark sums its statements, so
 * that only reorders the per-statement rows.
 */
export async function recordStatements(
  label: string,
  fn: (db: Database) => Promise<unknown>
): Promise<Statement[]> {
  const statements: Statement[] = [];
  const db = drizzle(pool, {
    schema,
    logger: {
      logQuery: (sql, params) =>
        statements.push({ label: `${label}.${statements.length}`, sql, params }),
    },
  });
  await fn(db);
  return statements;
}

/** Closes the app pool `recordStatements` opened, so the process can exit. */
export async function closeRecording(): Promise<void> {
  await pool.end();
}
