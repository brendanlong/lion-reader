import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Sentry from "@sentry/nextjs";

import { logger } from "@/lib/logger";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is not set");
}

export const pool = new Pool({
  connectionString,
});

// Handle unexpected errors on idle clients in the pool.
// Without this handler, connection failures cause uncaughtException and crash the process.
// The pool automatically removes failed clients and creates new ones when needed.
pool.on("error", (err) => {
  logger.error("Unexpected error on idle database client", {
    code: (err as { code?: string }).code,
    message: err.message,
  });
  Sentry.captureException(err, {
    tags: { source: "pg-pool" },
  });
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
