/**
 * Metrics module exports
 *
 * This module provides Prometheus metrics collection for Lion Reader.
 * Metrics are disabled by default and can be enabled by setting
 * METRICS_ENABLED=true in environment variables.
 */

export {
  // Core
  metricsEnabled,
  registry,
  trackMetric,

  // HTTP metrics
  httpRequestsTotal,
  httpRequestDurationSeconds,
  trackHttpRequest,
  startHttpTimer,

  // Feed fetch metrics
  feedFetchTotal,
  feedFetchDurationSeconds,
  trackFeedFetch,
  startFeedFetchTimer,
  type FeedFetchStatus,

  // Job metrics
  jobProcessedTotal,
  jobDurationSeconds,
  jobQueueSize,
  trackJobProcessed,
  setJobQueueSize,
  updateJobQueueMetrics,
  type JobStatus,

  // SSE metrics
  sseConnectionsActive,
  sseEventsSentTotal,
  incrementSSEConnections,
  decrementSSEConnections,
  trackSSEEventSent,

  // Business metrics
  usersTotal,
  subscriptionsTotal,
  entriesTotal,
  feedsTotal,
  updateBusinessMetrics,
} from "./metrics";

export { collectAllMetrics, collectBusinessMetrics, collectJobQueueMetrics } from "./collect";
