import { getTableName, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Database } from "@/server/db";

/**
 * The planner's row estimate, for tables too big to count(*) on demand.
 * reltuples lives in the catalog, so unlike the cumulative stats (n_live_tup)
 * it survives a crash or failover; vacuum and analyze keep it current. NULL
 * until the table is first analyzed (reltuples is -1).
 */
export async function estimateRows(db: Database, table: PgTable): Promise<number | null> {
  const result = await db.execute<{ estimate: number | null }>(
    sql`SELECT NULLIF(reltuples, -1)::float8 AS estimate FROM pg_class WHERE oid = ${getTableName(table)}::regclass`
  );
  return result.rows[0].estimate;
}
