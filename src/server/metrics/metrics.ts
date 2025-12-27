import { Registry, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus Metrics Registry
 *
 * Metrics are only collected when METRICS_ENABLED=true to avoid
 * any overhead when metrics are disabled.
 *
 * This module provides:
 * - A shared registry for all metrics
 * - Conditional initialization of default collectors
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
