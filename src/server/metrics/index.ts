/**
 * Metrics module exports
 *
 * This module provides Prometheus metrics collection for Lion Reader.
 * Metrics are disabled by default and can be enabled by setting
 * METRICS_ENABLED=true in environment variables.
 */

export {
  metricsEnabled,
  registry,
  trackMetric,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  trackHttpRequest,
  startHttpTimer,
} from "./metrics";
