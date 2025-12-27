import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/logger";

/**
 * Health check endpoint for Fly.io and load balancers
 *
 * Returns 200 OK when the service is healthy.
 * This endpoint is used by Fly.io's health checks to determine
 * if the application is ready to receive traffic.
 *
 * Checks:
 * - Database connectivity
 * - Redis connectivity
 *
 * Returns detailed status for each dependency.
 */

interface HealthCheckResult {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  version?: string;
  checks: {
    database: ComponentHealth;
    redis: ComponentHealth;
  };
}

interface ComponentHealth {
  status: "healthy" | "unhealthy";
  latencyMs?: number;
  error?: string;
}

/**
 * Checks database connectivity by running a simple query.
 */
async function checkDatabase(): Promise<ComponentHealth> {
  const start = Date.now();

  try {
    // Dynamic import to avoid initialization issues during health checks
    const { db } = await import("@/server/db");

    // Run a simple query to test connectivity
    await db.execute(sql`SELECT 1`);

    return {
      status: "healthy",
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error("Database health check failed", { error: errorMessage });

    return {
      status: "unhealthy",
      latencyMs: Date.now() - start,
      error: errorMessage,
    };
  }
}

/**
 * Checks Redis connectivity by running a PING command.
 */
async function checkRedis(): Promise<ComponentHealth> {
  const start = Date.now();

  try {
    // Dynamic import to avoid initialization issues during health checks
    const { redis } = await import("@/server/redis");

    // Run PING command to test connectivity
    const result = await redis.ping();

    if (result !== "PONG") {
      return {
        status: "unhealthy",
        latencyMs: Date.now() - start,
        error: `Unexpected PING response: ${result}`,
      };
    }

    return {
      status: "healthy",
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error("Redis health check failed", { error: errorMessage });

    return {
      status: "unhealthy",
      latencyMs: Date.now() - start,
      error: errorMessage,
    };
  }
}

export async function GET(): Promise<NextResponse> {
  const [databaseHealth, redisHealth] = await Promise.all([checkDatabase(), checkRedis()]);

  const checks = {
    database: databaseHealth,
    redis: redisHealth,
  };

  // Determine overall status
  const allHealthy = Object.values(checks).every((c) => c.status === "healthy");
  const allUnhealthy = Object.values(checks).every((c) => c.status === "unhealthy");

  let overallStatus: HealthCheckResult["status"];
  if (allHealthy) {
    overallStatus = "healthy";
  } else if (allUnhealthy) {
    overallStatus = "unhealthy";
  } else {
    overallStatus = "degraded";
  }

  const result: HealthCheckResult = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version,
    checks,
  };

  // Return 200 for healthy/degraded, 503 for unhealthy
  const httpStatus = overallStatus === "unhealthy" ? 503 : 200;

  return NextResponse.json(result, { status: httpStatus });
}
