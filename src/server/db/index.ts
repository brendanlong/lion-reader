import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Sentry from "@sentry/nextjs";

import { logger } from "@/lib/logger";
import { trackDbPoolClientError } from "@/server/metrics/metrics";
import { isDisconnectError } from "./errors";
import * as schema from "./schema";
import { timestamptzRawParserConfig } from "./temporal";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is not set");
}

// By default node-postgres parses `timestamptz` into a JS Date, which truncates
// Postgres's microsecond precision to milliseconds and silently corrupted keyset
// cursors built from timestamps (#680, #683). timestamptzRawParserConfig returns
// the raw Postgres string instead: Drizzle's built-in `timestamp` columns still
// map it to a Date (unchanged), while precision-sensitive reads decode it to a
// full-precision Temporal.Instant (see src/server/db/temporal.ts). Scoped to this
// pool's clients, not global, so unrelated pg consumers keep the default behaviour.
export const pool = new Pool({
  connectionString,
  types: timestamptzRawParserConfig,
  // Default pg pool is 10, which can cause request queuing under moderate concurrency.
  // Fly.io managed Postgres allows 300 connections; with 2 app + 1 worker + 1 discord
  // process, peak usage during deploys (3 app) is ~3×20 + 10 + 10 = 80, well under limit.
  max: parseInt(process.env.PG_POOL_MAX || "20", 10),
  // Close idle connections before Fly.io's 60s proxy timeout to avoid "server conn crashed?" errors
  idleTimeoutMillis: 30000,
});

// Handle errors on idle clients in the pool.
// Without this handler, connection failures cause uncaughtException and crash the process.
// The pool automatically removes failed clients and creates new ones when needed.
//
// pg-pool only routes an error here for a client that is IDLE in the pool: it detaches
// this listener while a client is checked out, so an error during a query rejects that
// query instead and is reported by whoever ran it. By the time we get here the pool has
// already removed the client, so there is nothing to recover.
//
// That makes a plain disconnect uninteresting, and there are a lot of them: Fly's
// Postgres proxy tears down every established connection whenever its health check
// flaps, so each occurrence produces one error per idle connection on every machine at
// once. Reporting those to Sentry buried real errors under thousands of events, so they
// are logged and counted instead; only genuinely unexpected errors are captured.
pool.on("error", (err) => {
  const disconnected = isDisconnectError(err);
  trackDbPoolClientError(disconnected ? "disconnect" : "unexpected");

  const context = {
    code: (err as { code?: string }).code,
    message: err.message,
  };

  if (disconnected) {
    logger.warn("Idle database connection closed by the server", context);
    return;
  }

  logger.error("Unexpected error on idle database client", context);
  Sentry.captureException(err, {
    tags: { source: "pg-pool" },
  });
});

// Log warnings when pool has waiting requests, indicating connection pressure.
// Check every 10 seconds to avoid log spam while still catching issues.
const POOL_MONITOR_INTERVAL_MS = 10_000;
let poolMonitorTimer: ReturnType<typeof setInterval> | null = null;

function startPoolMonitor(): void {
  if (poolMonitorTimer) return;

  poolMonitorTimer = setInterval(() => {
    if (pool.waitingCount > 0) {
      logger.warn("Database pool has waiting requests", {
        waitingCount: pool.waitingCount,
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        maxConnections: pool.options.max,
      });
    }
  }, POOL_MONITOR_INTERVAL_MS);

  // Don't prevent process exit
  poolMonitorTimer.unref();
}

startPoolMonitor();

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

/** A transaction handle, as passed to `db.transaction(async (tx) => ...)`. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Either the root `db` or an open transaction. Use this for service functions
 * that must be callable both standalone and inside a caller's transaction.
 */
export type DbOrTx = Database | Transaction;
