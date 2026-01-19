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

  // HTTP metrics
  startHttpTimer,

  // Feed fetch metrics

  // Job metrics

  // SSE metrics

  // Business metrics

  // Narration metrics
  trackNarrationGenerated,
  trackNarrationGenerationError,
  startNarrationGenerationTimer,

  // Enhanced voice metrics
  trackEnhancedVoiceSelected,
  trackEnhancedVoiceDownloadCompleted,
  trackEnhancedVoiceDownloadFailed,
  trackNarrationPlaybackStarted,
  type EnhancedVoiceDownloadErrorType,

  // Narration highlighting metrics
  trackNarrationHighlightActive,
  trackNarrationHighlightFallback,
  trackNarrationHighlightScroll,
} from "./metrics";

export { collectAllMetrics } from "./collect";

export { startMetricsServer, stopMetricsServer } from "./server";
