import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from "prom-client";
import type { CounterConfiguration, HistogramConfiguration, GaugeConfiguration } from "prom-client";

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
 *
 * Anchored on `globalThis` (via a well-known Symbol) rather than a plain module
 * singleton, because in production the Next.js app process instantiates this
 * module in MULTIPLE separate module graphs within the one OS process: the
 * custom-server bundle (`scripts/server.ts`), the Next instrumentation hook
 * (`src/instrumentation.ts`, which starts the /metrics server), and the
 * route-handler chunks (where `startHttpTimer` runs). A plain `new Registry()`
 * gives each graph its OWN registry, so the HTTP metrics observed by the route
 * handlers land on a registry the scrape never reads — which is exactly why
 * `http_request_*` stayed empty while DB-collected metrics worked. globalThis is
 * shared across every module graph in the process, so all copies converge on a
 * single registry — the same bridge `src/server/shutdown.ts` uses.
 */
const REGISTRY_KEY = Symbol.for("lion-reader.metrics.registry");
type GlobalWithMetricsRegistry = typeof globalThis & { [REGISTRY_KEY]?: Registry };

function getSharedRegistry(): Registry {
  const globalWithRegistry = globalThis as GlobalWithMetricsRegistry;
  let shared = globalWithRegistry[REGISTRY_KEY];
  if (!shared) {
    shared = new Registry();
    // Register default collectors once, on the shared registry (only when
    // enabled — avoids any overhead when metrics are off).
    if (metricsEnabled) {
      collectDefaultMetrics({ register: shared });
    }
    globalWithRegistry[REGISTRY_KEY] = shared;
  }
  return shared;
}

export const registry = getSharedRegistry();

/**
 * Idempotent metric constructors.
 *
 * Because this module is evaluated once per module graph (see above) but they
 * all share one registry, a second evaluation must REUSE the metric objects the
 * first one registered rather than construct new ones: prom-client throws on
 * duplicate registration, and only the object actually wired into the shared
 * registry shows up in the scrape. `getSingleMetric` returns the existing object
 * so every graph's `startHttpTimer` / `track*` call mutates the scraped metric.
 * Returns null when metrics are disabled (callers already null-check).
 */
function getOrCreateCounter<T extends string>(config: CounterConfiguration<T>): Counter<T> | null {
  if (!metricsEnabled) return null;
  const existing = registry.getSingleMetric(config.name);
  if (existing) return existing as Counter<T>;
  return new Counter<T>({ ...config, registers: [registry] });
}

function getOrCreateHistogram<T extends string>(
  config: HistogramConfiguration<T>
): Histogram<T> | null {
  if (!metricsEnabled) return null;
  const existing = registry.getSingleMetric(config.name);
  if (existing) return existing as Histogram<T>;
  return new Histogram<T>({ ...config, registers: [registry] });
}

function getOrCreateGauge<T extends string>(config: GaugeConfiguration<T>): Gauge<T> | null {
  if (!metricsEnabled) return null;
  const existing = registry.getSingleMetric(config.name);
  if (existing) return existing as Gauge<T>;
  return new Gauge<T>({ ...config, registers: [registry] });
}

// ============================================================================
// HTTP Metrics
// ============================================================================

/**
 * Counter for total HTTP requests.
 * Labels: method (GET, POST, etc.), path (normalized route), status (HTTP status code)
 */
const httpRequestsTotal = getOrCreateCounter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "path", "status"] as const,
});

/**
 * Histogram for HTTP request duration in seconds.
 * Labels: method (GET, POST, etc.), path (normalized route)
 *
 * Buckets are chosen to capture typical web latencies:
 * - 5ms, 10ms, 25ms: fast responses
 * - 50ms, 100ms, 250ms: typical responses
 * - 500ms, 1s, 2.5s, 5s, 10s: slow responses
 */
const httpRequestDurationSeconds = getOrCreateHistogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "path"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

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
const feedFetchTotal = getOrCreateCounter({
  name: "feed_fetch_total",
  help: "Total feed fetch attempts",
  labelNames: ["status"] as const,
});

/**
 * Histogram for feed fetch duration in seconds.
 * Tracks time from HTTP request start to response fully processed.
 *
 * Buckets cover typical fetch times from 50ms to 30s.
 */
const feedFetchDurationSeconds = getOrCreateHistogram({
  name: "feed_fetch_duration_seconds",
  help: "Feed fetch duration in seconds",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

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
// Content Processing Metrics
// ============================================================================

/**
 * Buckets for the content-processing steps (feed parsing, readability
 * extraction, HTML sanitization). These run an order of magnitude faster than
 * a feed fetch — sanitization is ~1ms/100KB — so the buckets start well below
 * a millisecond and stretch to a few seconds to catch pathologically large
 * bodies, giving useful p50/p90/p99 resolution across the fast common case.
 */
const CONTENT_PROCESSING_BUCKETS = [
  0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];

/**
 * Histogram for feed parsing (RSS/Atom/JSON) duration in seconds.
 * Measures only the parse step, not the surrounding fetch or processing.
 */
const feedParseDurationSeconds = getOrCreateHistogram({
  name: "feed_parse_duration_seconds",
  help: "Feed parsing (RSS/Atom/JSON) duration in seconds",
  buckets: CONTENT_PROCESSING_BUCKETS,
});

/**
 * Histogram for readability (article extraction) duration in seconds.
 * Measures only the native extraction step.
 */
const readabilityDurationSeconds = getOrCreateHistogram({
  name: "readability_duration_seconds",
  help: "Readability article extraction duration in seconds",
  buckets: CONTENT_PROCESSING_BUCKETS,
});

/**
 * Histogram for HTML sanitization duration in seconds.
 * Measures only the native sanitizer pass.
 */
const sanitizeDurationSeconds = getOrCreateHistogram({
  name: "sanitize_duration_seconds",
  help: "HTML sanitization duration in seconds",
  buckets: CONTENT_PROCESSING_BUCKETS,
});

/**
 * Creates a timer for tracking feed parse duration.
 * Returns a function to call when parsing completes.
 * Returns a no-op function when metrics are disabled.
 */
export function startFeedParseTimer(): () => void {
  return startContentProcessingTimer(feedParseDurationSeconds);
}

/**
 * Creates a timer for tracking readability extraction duration.
 * Returns a function to call when extraction completes.
 * Returns a no-op function when metrics are disabled.
 */
export function startReadabilityTimer(): () => void {
  return startContentProcessingTimer(readabilityDurationSeconds);
}

/**
 * Creates a timer for tracking HTML sanitization duration.
 * Returns a function to call when sanitization completes.
 * Returns a no-op function when metrics are disabled.
 */
export function startSanitizeTimer(): () => void {
  return startContentProcessingTimer(sanitizeDurationSeconds);
}

/**
 * Shared implementation for the content-processing timers. Returns a no-op
 * when metrics are disabled so callers have zero overhead.
 */
function startContentProcessingTimer(histogram: Histogram | null): () => void {
  if (!metricsEnabled || !histogram) {
    return () => {};
  }

  const startTime = performance.now();

  return () => {
    histogram.observe((performance.now() - startTime) / 1000);
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
const jobProcessedTotal = getOrCreateCounter({
  name: "job_processed_total",
  help: "Total jobs processed",
  labelNames: ["type", "status"] as const,
});

/**
 * Histogram for job processing duration in seconds.
 * Labels: type (fetch_feed, cleanup, etc.)
 *
 * Buckets cover typical job durations from 10ms to 5 minutes.
 */
const jobDurationSeconds = getOrCreateHistogram({
  name: "job_duration_seconds",
  help: "Job processing duration in seconds",
  labelNames: ["type"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
});

/**
 * Gauge for current job queue size.
 * Labels: type (fetch_feed, cleanup, etc.), status (pending, running)
 */
const jobQueueSize = getOrCreateGauge({
  name: "job_queue_size",
  help: "Current job queue size by type and status",
  labelNames: ["type", "status"] as const,
});

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
const sseConnectionsActive = getOrCreateGauge({
  name: "sse_connections_active",
  help: "Number of active SSE connections",
});

/**
 * Counter for total SSE events sent.
 * Labels: type (new_entry, entry_updated, heartbeat)
 */
const sseEventsSentTotal = getOrCreateCounter({
  name: "sse_events_sent_total",
  help: "Total SSE events sent to clients",
  labelNames: ["type"] as const,
});

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
// Database Pool Metrics
// ============================================================================

/**
 * Gauge for database connection pool total connections.
 */
const dbPoolTotalConnections = getOrCreateGauge({
  name: "db_pool_total_connections",
  help: "Total connections in the database pool",
});

/**
 * Gauge for database connection pool idle connections.
 */
const dbPoolIdleConnections = getOrCreateGauge({
  name: "db_pool_idle_connections",
  help: "Idle connections in the database pool",
});

/**
 * Gauge for database connection pool waiting requests.
 */
const dbPoolWaitingRequests = getOrCreateGauge({
  name: "db_pool_waiting_requests",
  help: "Requests waiting for a database connection",
});

/**
 * Updates database pool metrics from pg Pool stats.
 * This function has zero overhead when metrics are disabled.
 */
export function updateDbPoolMetrics(stats: {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}): void {
  if (!metricsEnabled) return;

  dbPoolTotalConnections?.set(stats.totalCount);
  dbPoolIdleConnections?.set(stats.idleCount);
  dbPoolWaitingRequests?.set(stats.waitingCount);
}

// ============================================================================
// Business Metrics
// ============================================================================

/**
 * Gauge for total registered users.
 */
const usersTotal = getOrCreateGauge({
  name: "users_total",
  help: "Total number of registered users",
});

/**
 * Gauge for total active subscriptions.
 */
const subscriptionsTotal = getOrCreateGauge({
  name: "subscriptions_total",
  help: "Total number of active subscriptions",
});

/**
 * Gauge for total entries in the database.
 */
const entriesTotal = getOrCreateGauge({
  name: "entries_total",
  help: "Total number of entries",
});

/**
 * Gauge for total feeds in the database.
 */
const feedsTotal = getOrCreateGauge({
  name: "feeds_total",
  help: "Total number of feeds",
});

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
const websubNotificationsReceivedTotal = getOrCreateCounter({
  name: "websub_notifications_received_total",
  help: "Total WebSub content notifications received",
});

/**
 * Counter for WebSub renewal attempts.
 * Labels: status (success, failure)
 */
const websubRenewalsTotal = getOrCreateCounter({
  name: "websub_renewals_total",
  help: "Total WebSub subscription renewal attempts",
  labelNames: ["status"] as const,
});

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
// Feed Fetch Health Metrics
// ============================================================================

/**
 * Gauge for the age of the most recent successful feed fetch.
 * Updated by the monitor_feed_health job. Alert if this grows beyond the
 * expected fetch cadence (feeds are polled at least hourly in steady state).
 */
const feedLastSuccessfulFetchAgeSeconds = getOrCreateGauge({
  name: "feed_last_successful_fetch_age_seconds",
  help: "Seconds since the most recent successful feed fetch across all pollable feeds",
});

/**
 * Gauge for the number of pollable feeds currently failing (consecutive_failures > 0).
 * Updated by the monitor_feed_health job.
 */
const feedsFailing = getOrCreateGauge({
  name: "feeds_failing",
  help: "Number of pollable feeds with consecutive fetch failures",
});

/**
 * Updates feed fetch health gauges from a monitor_feed_health run.
 * This function has zero overhead when metrics are disabled.
 *
 * @param lastSuccessAgeSeconds - Age of the newest successful fetch, or null if none exists
 * @param failingFeedCount - Number of pollable feeds currently failing
 */
export function updateFeedHealthMetrics(
  lastSuccessAgeSeconds: number | null,
  failingFeedCount: number
): void {
  if (!metricsEnabled) return;
  // null = no feed has ever fetched successfully, so there is no age to report.
  // The gauge is left untouched (rather than set to 0, which would look healthy);
  // Prometheus alerts for that state should key on `feeds_failing`, which is
  // always set, while the healthchecks.io `/fail` ping is the primary signal.
  if (lastSuccessAgeSeconds !== null) {
    feedLastSuccessfulFetchAgeSeconds?.set(lastSuccessAgeSeconds);
  }
  feedsFailing?.set(failingFeedCount);
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
const narrationGeneratedTotal = getOrCreateCounter({
  name: "narration_generated_total",
  help: "Total narration generations",
  labelNames: ["cached", "source"] as const,
});

/**
 * Histogram for narration generation duration in seconds.
 * Tracks time for LLM generation (not fallback or cached).
 *
 * Buckets cover typical LLM latencies from 100ms to 30s.
 */
const narrationGenerationDurationSeconds = getOrCreateHistogram({
  name: "narration_generation_duration_seconds",
  help: "Narration generation duration in seconds",
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30],
});

/**
 * Counter for narration generation errors.
 * Labels: error_type (api_error, empty_response, unknown)
 */
const narrationGenerationErrorsTotal = getOrCreateCounter({
  name: "narration_generation_errors_total",
  help: "Total narration generation errors",
  labelNames: ["error_type"] as const,
});

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
const enhancedVoiceSelectedTotal = getOrCreateCounter({
  name: "enhanced_voice_selected_total",
  help: "Total enhanced voice selections",
  labelNames: ["voice_id"] as const,
});

/**
 * Counter for enhanced voice download completions.
 * Labels: voice_id (the downloaded voice identifier)
 */
const enhancedVoiceDownloadCompletedTotal = getOrCreateCounter({
  name: "enhanced_voice_download_completed_total",
  help: "Total enhanced voice downloads completed",
  labelNames: ["voice_id"] as const,
});

/**
 * Counter for enhanced voice download failures.
 * Labels:
 * - voice_id: The voice that failed to download
 * - error_type: Type of error (network, storage, unknown)
 */
const enhancedVoiceDownloadFailedTotal = getOrCreateCounter({
  name: "enhanced_voice_download_failed_total",
  help: "Total enhanced voice download failures",
  labelNames: ["voice_id", "error_type"] as const,
});

/**
 * Counter for narration playback starts.
 * Labels: provider (browser or piper)
 */
const narrationPlaybackStartedTotal = getOrCreateCounter({
  name: "narration_playback_started_total",
  help: "Total narration playbacks started",
  labelNames: ["provider"] as const,
});

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
const narrationHighlightActiveTotal = getOrCreateCounter({
  name: "narration_highlight_active_total",
  help: "Total times narration highlighting was active",
});

/**
 * Counter for times fallback mapping was used for highlighting.
 * Incremented when positional mapping is used instead of LLM markers.
 */
const narrationHighlightFallbackTotal = getOrCreateCounter({
  name: "narration_highlight_fallback_total",
  help: "Total times fallback positional mapping was used for highlighting",
});

/**
 * Counter for times auto-scroll was triggered during highlighting.
 * Incremented when the view scrolls to a highlighted paragraph.
 */
const narrationHighlightScrollTotal = getOrCreateCounter({
  name: "narration_highlight_scroll_total",
  help: "Total times auto-scroll was triggered during highlighting",
});

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
