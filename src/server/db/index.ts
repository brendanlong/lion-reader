import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Sentry from "@sentry/nextjs";

import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is not set");
}

const pool = new Pool({
  connectionString,
});

export const db = drizzle(pool, {
  schema,
  logger: {
    logQuery(query: string, params: unknown[]) {
      // Create a Sentry span for each database query to help diagnose N+1 issues
      const span = Sentry.startInactiveSpan({
        name: "db.query",
        op: "db.query",
        attributes: {
          "db.system": "postgresql",
          "db.statement": query.substring(0, 500), // Truncate long queries
          "db.params_count": params.length, // Include param count for debugging
        },
      });
      span?.end();
    },
  },
});

export type Database = typeof db;

export * from "./schema";
