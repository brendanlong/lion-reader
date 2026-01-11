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
const httpRequestsTotal = metricsEnabled
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
const httpRequestDurationSeconds = metricsEnabled
  ? new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request duration in seconds",
      labelNames: ["method", "path"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    })
  : null;

/**
 * Track an HTTP request.
 * This function has zero overhead when metrics are disabled.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - Normalized route path (e.g., /api/trpc/entries.list)
 * @param status - HTTP status code
 * @param durationMs - Request duration in milliseconds
 */
function trackHttpRequest(method: string, path: string, status: number, durationMs: number): void {
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
const feedFetchTotal = metricsEnabled
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
const feedFetchDurationSeconds = metricsEnabled
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
function trackFeedFetch(status: FeedFetchStatus, durationMs: number): void {
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
const jobProcessedTotal = metricsEnabled
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
const jobDurationSeconds = metricsEnabled
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
const jobQueueSize = metricsEnabled
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

// ============================================================================
// SSE Connection Metrics
// ============================================================================

/**
 * Gauge for active SSE connections.
 * Incremented when a client connects, decremented on disconnect.
 */
const sseConnectionsActive = metricsEnabled
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
const sseEventsSentTotal = metricsEnabled
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
const usersTotal = metricsEnabled
  ? new Gauge({
      name: "users_total",
      help: "Total number of registered users",
      registers: [registry],
    })
  : null;

/**
 * Gauge for total active subscriptions.
 */
const subscriptionsTotal = metricsEnabled
  ? new Gauge({
      name: "subscriptions_total",
      help: "Total number of active subscriptions",
      registers: [registry],
    })
  : null;

/**
 * Gauge for total entries in the database.
 */
const entriesTotal = metricsEnabled
  ? new Gauge({
      name: "entries_total",
      help: "Total number of entries",
      registers: [registry],
    })
  : null;

/**
 * Gauge for total feeds in the database.
 */
const feedsTotal = metricsEnabled
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

// ============================================================================
// WebSub Metrics
// ============================================================================

/**
 * Counter for WebSub notifications received.
 * Tracks content push notifications from hubs.
 */
const websubNotificationsReceivedTotal = metricsEnabled
  ? new Counter({
      name: "websub_notifications_received_total",
      help: "Total WebSub content notifications received",
      registers: [registry],
    })
  : null;

/**
 * Counter for WebSub renewal attempts.
 * Labels: status (success, failure)
 */
const websubRenewalsTotal = metricsEnabled
  ? new Counter({
      name: "websub_renewals_total",
      help: "Total WebSub subscription renewal attempts",
      labelNames: ["status"] as const,
      registers: [registry],
    })
  : null;

/**
 * Tracks a WebSub notification received.
 * This function has zero overhead when metrics are disabled.
 */
export function trackWebsubNotificationReceived(): void {
  if (!metricsEnabled) return;
  websubNotificationsReceivedTotal?.inc();
}

/**
 * Tracks a WebSub renewal attempt.
 * This function has zero overhead when metrics are disabled.
 *
 * @param success - Whether the renewal was successful
 */
export function trackWebsubRenewal(success: boolean): void {
  if (!metricsEnabled) return;
  websubRenewalsTotal?.inc({ status: success ? "success" : "failure" });
}

// ============================================================================
// Narration Metrics
// ============================================================================

/**
 * Narration source values.
 * - llm: Generated by LLM (Groq)
 * - fallback: Plain text conversion fallback
 */
export type NarrationSource = "llm" | "fallback";

/**
 * Narration error type values.
 * - api_error: Error from Groq API call
 * - empty_response: Groq returned empty response
 * - unknown: Unknown error type
 */
export type NarrationErrorType = "api_error" | "empty_response" | "unknown";

/**
 * Counter for total narration generations.
 * Labels:
 * - cached: "true" if served from cache, "false" if newly generated
 * - source: "llm" for LLM-generated, "fallback" for plain text conversion
 */
const narrationGeneratedTotal = metricsEnabled
  ? new Counter({
      name: "narration_generated_total",
      help: "Total narration generations",
      labelNames: ["cached", "source"] as const,
      registers: [registry],
    })
  : null;

/**
 * Histogram for narration generation duration in seconds.
 * Tracks time for LLM generation (not fallback or cached).
 *
 * Buckets cover typical LLM latencies from 100ms to 30s.
 */
const narrationGenerationDurationSeconds = metricsEnabled
  ? new Histogram({
      name: "narration_generation_duration_seconds",
      help: "Narration generation duration in seconds",
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30],
      registers: [registry],
    })
  : null;

/**
 * Counter for narration generation errors.
 * Labels: error_type (api_error, empty_response, unknown)
 */
const narrationGenerationErrorsTotal = metricsEnabled
  ? new Counter({
      name: "narration_generation_errors_total",
      help: "Total narration generation errors",
      labelNames: ["error_type"] as const,
      registers: [registry],
    })
  : null;

/**
 * Tracks a narration generation result.
 * This function has zero overhead when metrics are disabled.
 *
 * @param cached - Whether narration was served from cache
 * @param source - The narration source (llm or fallback)
 */
export function trackNarrationGenerated(cached: boolean, source: NarrationSource): void {
  if (!metricsEnabled) return;
  narrationGeneratedTotal?.inc({ cached: String(cached), source });
}

/**
 * Tracks narration generation duration.
 * This function has zero overhead when metrics are disabled.
 *
 * @param durationMs - Generation duration in milliseconds
 */
function trackNarrationGenerationDuration(durationMs: number): void {
  if (!metricsEnabled) return;
  narrationGenerationDurationSeconds?.observe(durationMs / 1000);
}

/**
 * Tracks a narration generation error.
 * This function has zero overhead when metrics are disabled.
 *
 * @param errorType - The type of error that occurred
 */
export function trackNarrationGenerationError(errorType: NarrationErrorType): void {
  if (!metricsEnabled) return;
  narrationGenerationErrorsTotal?.inc({ error_type: errorType });
}

/**
 * Creates a timer for tracking narration generation duration.
 * Returns a function to call when generation completes.
 * Returns a no-op function when metrics are disabled.
 *
 * @returns Function to call when generation completes
 */
export function startNarrationGenerationTimer(): () => void {
  if (!metricsEnabled) {
    return () => {};
  }

  const startTime = performance.now();

  return () => {
    const durationMs = performance.now() - startTime;
    trackNarrationGenerationDuration(durationMs);
  };
}

// ============================================================================
// Enhanced Voice Metrics
// ============================================================================

/**
 * Counter for enhanced voice selections.
 * Labels: voice_id (the selected voice identifier)
 */
const enhancedVoiceSelectedTotal = metricsEnabled
  ? new Counter({
      name: "enhanced_voice_selected_total",
      help: "Total enhanced voice selections",
      labelNames: ["voice_id"] as const,
      registers: [registry],
    })
  : null;

/**
 * Counter for enhanced voice download completions.
 * Labels: voice_id (the downloaded voice identifier)
 */
const enhancedVoiceDownloadCompletedTotal = metricsEnabled
  ? new Counter({
      name: "enhanced_voice_download_completed_total",
      help: "Total enhanced voice downloads completed",
      labelNames: ["voice_id"] as const,
      registers: [registry],
    })
  : null;

/**
 * Counter for enhanced voice download failures.
 * Labels:
 * - voice_id: The voice that failed to download
 * - error_type: Type of error (network, storage, unknown)
 */
const enhancedVoiceDownloadFailedTotal = metricsEnabled
  ? new Counter({
      name: "enhanced_voice_download_failed_total",
      help: "Total enhanced voice download failures",
      labelNames: ["voice_id", "error_type"] as const,
      registers: [registry],
    })
  : null;

/**
 * Counter for narration playback starts.
 * Labels: provider (browser or piper)
 */
const narrationPlaybackStartedTotal = metricsEnabled
  ? new Counter({
      name: "narration_playback_started_total",
      help: "Total narration playbacks started",
      labelNames: ["provider"] as const,
      registers: [registry],
    })
  : null;

/**
 * Enhanced voice download error types.
 * - network: Network or fetch error
 * - storage: IndexedDB or quota error
 * - unknown: Unknown error type
 */
export type EnhancedVoiceDownloadErrorType = "network" | "storage" | "unknown";

/**
 * Tracks an enhanced voice selection.
 * This function has zero overhead when metrics are disabled.
 *
 * @param voiceId - The ID of the selected voice
 */
export function trackEnhancedVoiceSelected(voiceId: string): void {
  if (!metricsEnabled) return;
  enhancedVoiceSelectedTotal?.inc({ voice_id: voiceId });
}

/**
 * Tracks a successful enhanced voice download.
 * This function has zero overhead when metrics are disabled.
 *
 * @param voiceId - The ID of the downloaded voice
 */
export function trackEnhancedVoiceDownloadCompleted(voiceId: string): void {
  if (!metricsEnabled) return;
  enhancedVoiceDownloadCompletedTotal?.inc({ voice_id: voiceId });
}

/**
 * Tracks a failed enhanced voice download.
 * This function has zero overhead when metrics are disabled.
 *
 * @param voiceId - The ID of the voice that failed to download
 * @param errorType - The type of error that occurred
 */
export function trackEnhancedVoiceDownloadFailed(
  voiceId: string,
  errorType: EnhancedVoiceDownloadErrorType
): void {
  if (!metricsEnabled) return;
  enhancedVoiceDownloadFailedTotal?.inc({ voice_id: voiceId, error_type: errorType });
}

/**
 * Tracks a narration playback start.
 * This function has zero overhead when metrics are disabled.
 *
 * @param provider - The TTS provider used (browser or piper)
 */
export function trackNarrationPlaybackStarted(provider: "browser" | "piper"): void {
  if (!metricsEnabled) return;
  narrationPlaybackStartedTotal?.inc({ provider });
}

// ============================================================================
// Narration Highlighting Metrics
// ============================================================================

/**
 * Counter for times highlighting was active during narration.
 * Incremented when highlighting first becomes active in a session.
 */
const narrationHighlightActiveTotal = metricsEnabled
  ? new Counter({
      name: "narration_highlight_active_total",
      help: "Total times narration highlighting was active",
      registers: [registry],
    })
  : null;

/**
 * Counter for times fallback mapping was used for highlighting.
 * Incremented when positional mapping is used instead of LLM markers.
 */
const narrationHighlightFallbackTotal = metricsEnabled
  ? new Counter({
      name: "narration_highlight_fallback_total",
      help: "Total times fallback positional mapping was used for highlighting",
      registers: [registry],
    })
  : null;

/**
 * Counter for times auto-scroll was triggered during highlighting.
 * Incremented when the view scrolls to a highlighted paragraph.
 */
const narrationHighlightScrollTotal = metricsEnabled
  ? new Counter({
      name: "narration_highlight_scroll_total",
      help: "Total times auto-scroll was triggered during highlighting",
      registers: [registry],
    })
  : null;

/**
 * Tracks when narration highlighting becomes active.
 * This function has zero overhead when metrics are disabled.
 */
export function trackNarrationHighlightActive(): void {
  if (!metricsEnabled) return;
  narrationHighlightActiveTotal?.inc();
}

/**
 * Tracks when fallback positional mapping is used for highlighting.
 * This function has zero overhead when metrics are disabled.
 */
export function trackNarrationHighlightFallback(): void {
  if (!metricsEnabled) return;
  narrationHighlightFallbackTotal?.inc();
}

/**
 * Tracks when auto-scroll is triggered during highlighting.
 * This function has zero overhead when metrics are disabled.
 */
export function trackNarrationHighlightScroll(): void {
  if (!metricsEnabled) return;
  narrationHighlightScrollTotal?.inc();
}
