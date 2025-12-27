import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from "prom-client";

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
 * - Feed fetch metrics
 * - Job processing metrics
 * - SSE connection metrics
 * - Business metrics (users, subscriptions, entries)
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

// ============================================================================
// Feed Fetch Metrics
// ============================================================================

/**
 * Feed fetch status values.
 * - success: Feed fetched and parsed successfully
 * - not_modified: 304 response, feed content unchanged
 * - error: Any fetch error (network, parsing, HTTP error)
 */
export type FeedFetchStatus = "success" | "not_modified" | "error";

/**
 * Counter for total feed fetches.
 * Labels: status (success, not_modified, error)
 */
export const feedFetchTotal = metricsEnabled
  ? new Counter({
      name: "feed_fetch_total",
      help: "Total feed fetch attempts",
      labelNames: ["status"] as const,
      registers: [registry],
    })
  : null;

/**
 * Histogram for feed fetch duration in seconds.
 * Tracks time from HTTP request start to response fully processed.
 *
 * Buckets cover typical fetch times from 50ms to 30s.
 */
export const feedFetchDurationSeconds = metricsEnabled
  ? new Histogram({
      name: "feed_fetch_duration_seconds",
      help: "Feed fetch duration in seconds",
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [registry],
    })
  : null;

/**
 * Tracks a feed fetch result.
 * This function has zero overhead when metrics are disabled.
 *
 * @param status - The fetch result status
 * @param durationMs - Fetch duration in milliseconds
 */
export function trackFeedFetch(status: FeedFetchStatus, durationMs: number): void {
  if (!metricsEnabled) return;

  feedFetchTotal?.inc({ status });
  feedFetchDurationSeconds?.observe(durationMs / 1000);
}

/**
 * Creates a timer for tracking feed fetch duration.
 * Returns a function to call when the fetch completes.
 * Returns a no-op function when metrics are disabled.
 *
 * @returns Function to call with status when fetch completes
 */
export function startFeedFetchTimer(): (status: FeedFetchStatus) => void {
  if (!metricsEnabled) {
    return () => {};
  }

  const startTime = performance.now();

  return (status: FeedFetchStatus) => {
    const durationMs = performance.now() - startTime;
    trackFeedFetch(status, durationMs);
  };
}

// ============================================================================
// Job Processing Metrics
// ============================================================================

/**
 * Job processing status values.
 * - success: Job completed successfully
 * - failure: Job failed (may be retried)
 */
export type JobStatus = "success" | "failure";

/**
 * Counter for total jobs processed.
 * Labels: type (fetch_feed, cleanup, etc.), status (success, failure)
 */
export const jobProcessedTotal = metricsEnabled
  ? new Counter({
      name: "job_processed_total",
      help: "Total jobs processed",
      labelNames: ["type", "status"] as const,
      registers: [registry],
    })
  : null;

/**
 * Histogram for job processing duration in seconds.
 * Labels: type (fetch_feed, cleanup, etc.)
 *
 * Buckets cover typical job durations from 10ms to 5 minutes.
 */
export const jobDurationSeconds = metricsEnabled
  ? new Histogram({
      name: "job_duration_seconds",
      help: "Job processing duration in seconds",
      labelNames: ["type"] as const,
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
      registers: [registry],
    })
  : null;

/**
 * Gauge for current job queue size.
 * Labels: type (fetch_feed, cleanup, etc.), status (pending, running)
 */
export const jobQueueSize = metricsEnabled
  ? new Gauge({
      name: "job_queue_size",
      help: "Current job queue size by type and status",
      labelNames: ["type", "status"] as const,
      registers: [registry],
    })
  : null;

/**
 * Tracks a job processing result.
 * This function has zero overhead when metrics are disabled.
 *
 * @param type - Job type (fetch_feed, cleanup, etc.)
 * @param status - Processing result status
 * @param durationMs - Processing duration in milliseconds
 */
export function trackJobProcessed(type: string, status: JobStatus, durationMs: number): void {
  if (!metricsEnabled) return;

  jobProcessedTotal?.inc({ type, status });
  jobDurationSeconds?.observe({ type }, durationMs / 1000);
}

/**
 * Updates the job queue size gauge.
 * This function has zero overhead when metrics are disabled.
 *
 * @param type - Job type
 * @param status - Job status (pending, running)
 * @param count - Number of jobs in this state
 */
export function setJobQueueSize(type: string, status: string, count: number): void {
  if (!metricsEnabled) return;

  jobQueueSize?.set({ type, status }, count);
}

// ============================================================================
// SSE Connection Metrics
// ============================================================================

/**
 * Gauge for active SSE connections.
 * Incremented when a client connects, decremented on disconnect.
 */
export const sseConnectionsActive = metricsEnabled
  ? new Gauge({
      name: "sse_connections_active",
      help: "Number of active SSE connections",
      registers: [registry],
    })
  : null;

/**
 * Counter for total SSE events sent.
 * Labels: type (new_entry, entry_updated, heartbeat)
 */
export const sseEventsSentTotal = metricsEnabled
  ? new Counter({
      name: "sse_events_sent_total",
      help: "Total SSE events sent to clients",
      labelNames: ["type"] as const,
      registers: [registry],
    })
  : null;

/**
 * Increments the active SSE connections gauge.
 * This function has zero overhead when metrics are disabled.
 */
export function incrementSSEConnections(): void {
  if (!metricsEnabled) return;
  sseConnectionsActive?.inc();
}

/**
 * Decrements the active SSE connections gauge.
 * This function has zero overhead when metrics are disabled.
 */
export function decrementSSEConnections(): void {
  if (!metricsEnabled) return;
  sseConnectionsActive?.dec();
}

/**
 * Tracks an SSE event being sent.
 * This function has zero overhead when metrics are disabled.
 *
 * @param eventType - The type of event sent
 */
export function trackSSEEventSent(eventType: string): void {
  if (!metricsEnabled) return;
  sseEventsSentTotal?.inc({ type: eventType });
}

// ============================================================================
// Business Metrics
// ============================================================================

/**
 * Gauge for total registered users.
 */
export const usersTotal = metricsEnabled
  ? new Gauge({
      name: "users_total",
      help: "Total number of registered users",
      registers: [registry],
    })
  : null;

/**
 * Gauge for total active subscriptions.
 */
export const subscriptionsTotal = metricsEnabled
  ? new Gauge({
      name: "subscriptions_total",
      help: "Total number of active subscriptions",
      registers: [registry],
    })
  : null;

/**
 * Gauge for total entries in the database.
 */
export const entriesTotal = metricsEnabled
  ? new Gauge({
      name: "entries_total",
      help: "Total number of entries",
      registers: [registry],
    })
  : null;

/**
 * Gauge for total feeds in the database.
 */
export const feedsTotal = metricsEnabled
  ? new Gauge({
      name: "feeds_total",
      help: "Total number of feeds",
      registers: [registry],
    })
  : null;

/**
 * Updates all business metrics.
 * This function has zero overhead when metrics are disabled.
 *
 * @param counts - Object containing counts for each metric
 */
export function updateBusinessMetrics(counts: {
  users?: number;
  subscriptions?: number;
  entries?: number;
  feeds?: number;
}): void {
  if (!metricsEnabled) return;

  if (counts.users !== undefined) {
    usersTotal?.set(counts.users);
  }
  if (counts.subscriptions !== undefined) {
    subscriptionsTotal?.set(counts.subscriptions);
  }
  if (counts.entries !== undefined) {
    entriesTotal?.set(counts.entries);
  }
  if (counts.feeds !== undefined) {
    feedsTotal?.set(counts.feeds);
  }
}

/**
 * Updates job queue size metrics from database counts.
 * This function has zero overhead when metrics are disabled.
 *
 * @param counts - Job counts by type and status
 */
export function updateJobQueueMetrics(
  counts: Array<{ type: string; status: string; count: number }>
): void {
  if (!metricsEnabled) return;

  for (const { type, status, count } of counts) {
    jobQueueSize?.set({ type, status }, count);
  }
}
