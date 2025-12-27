import { Registry, collectDefaultMetrics, Counter, Histogram } from "prom-client";

/**
 * Prometheus Metrics Registry
 *
 * Metrics are only collected when METRICS_ENABLED=true to avoid
 * any overhead when metrics are disabled.
 *
 * This module provides:
 * - A shared registry for all metrics
 * - Conditional initialization of default collectors
 * - HTTP request metrics (counter and histogram)
 * - Helper functions for tracking metrics
 */

/**
 * Whether metrics collection is enabled.
 * Metrics are disabled by default for self-hosters who don't need them.
 */
export const metricsEnabled = process.env.METRICS_ENABLED === "true";

/**
 * Shared Prometheus registry for all metrics.
 * Use this registry when creating new metrics to ensure they're
 * all exported together from the /api/metrics endpoint.
 */
export const registry = new Registry();

// Only register default collectors when metrics are enabled
// This avoids any performance overhead when metrics are disabled
if (metricsEnabled) {
  collectDefaultMetrics({ register: registry });
}

// ============================================================================
// HTTP Metrics
// ============================================================================

/**
 * Counter for total HTTP requests.
 * Labels: method (GET, POST, etc.), path (normalized route), status (HTTP status code)
 */
export const httpRequestsTotal = metricsEnabled
  ? new Counter({
      name: "http_requests_total",
      help: "Total HTTP requests",
      labelNames: ["method", "path", "status"] as const,
      registers: [registry],
    })
  : null;

/**
 * Histogram for HTTP request duration in seconds.
 * Labels: method (GET, POST, etc.), path (normalized route)
 *
 * Buckets are chosen to capture typical web latencies:
 * - 5ms, 10ms, 25ms: fast responses
 * - 50ms, 100ms, 250ms: typical responses
 * - 500ms, 1s, 2.5s, 5s, 10s: slow responses
 */
export const httpRequestDurationSeconds = metricsEnabled
  ? new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request duration in seconds",
      labelNames: ["method", "path"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    })
  : null;

/**
 * Helper function for conditional metric tracking.
 * Use this to wrap metric updates so they're no-ops when disabled.
 *
 * @param fn - The metric update function to execute
 */
export function trackMetric(fn: () => void): void {
  if (!metricsEnabled) return;
  fn();
}

/**
 * Track an HTTP request.
 * This function has zero overhead when metrics are disabled.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - Normalized route path (e.g., /api/trpc/entries.list)
 * @param status - HTTP status code
 * @param durationMs - Request duration in milliseconds
 */
export function trackHttpRequest(
  method: string,
  path: string,
  status: number,
  durationMs: number
): void {
  if (!metricsEnabled) return;

  const durationSeconds = durationMs / 1000;

  httpRequestsTotal?.inc({
    method,
    path,
    status: String(status),
  });

  httpRequestDurationSeconds?.observe(
    {
      method,
      path,
    },
    durationSeconds
  );
}

/**
 * Creates a timer for tracking HTTP request duration.
 * Returns a function to call when the request completes.
 * Returns a no-op function when metrics are disabled.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - Normalized route path
 * @returns Function to call with status code when request completes
 */
export function startHttpTimer(method: string, path: string): (status: number) => void {
  if (!metricsEnabled) {
    // Return a no-op function when metrics are disabled
    return () => {};
  }

  const startTime = performance.now();

  return (status: number) => {
    const durationMs = performance.now() - startTime;
    trackHttpRequest(method, path, status, durationMs);
  };
}
