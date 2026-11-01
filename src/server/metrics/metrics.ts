import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from "prom-client";
import type { TTSProviderId } from "@/lib/narration/types";
import type { VoiceDownloadErrorType } from "@/lib/telemetry";

/**
 * Prometheus metrics, and the helpers the app records them with. Metric names
 * and labels are what the dashboards query, so don't rename them.
 *
 * Collected only with METRICS_ENABLED=true (off by default, for self-hosters
 * who don't need them): with it off every metric is null and every helper a
 * no-op.
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
 * Returns null when metrics are disabled, so every metric op below is `?.`.
 */
function getOrCreate<C extends { name: string }, M>(
  Metric: new (config: C & { registers: Registry[] }) => M,
  config: C
): M | null {
  if (!metricsEnabled) return null;
  return (
    (registry.getSingleMetric(config.name) as M | undefined) ??
    new Metric({ ...config, registers: [registry] })
  );
}

/**
 * Starts timing some work: the function returned, called when it ends, passes
 * `record` its duration in seconds along with what it's called with.
 */
function startTimer<A extends unknown[]>(
  record: (seconds: number, ...args: A) => void
): (...args: A) => void {
  if (!metricsEnabled) return () => {};
  const startTime = performance.now();
  return (...args) => record((performance.now() - startTime) / 1000, ...args);
}

/** A timer ({@link startTimer}) whose duration is all `histogram` records. */
function histogramTimer(histogram: Histogram | null): () => () => void {
  return () => startTimer((seconds) => histogram?.observe(seconds));
}

// ============================================================================
// HTTP Metrics
// ============================================================================

const httpRequestsTotal = getOrCreate(Counter, {
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "path", "status"] as const,
});

const httpRequestDurationSeconds = getOrCreate(Histogram, {
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "path"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

/** `path` is the normalized route; the timer is stopped with the response's status. */
export function startHttpTimer(method: string, path: string): (status: number) => void {
  return startTimer((seconds, status: number) => {
    httpRequestsTotal?.inc({ method, path, status: String(status) });
    httpRequestDurationSeconds?.observe({ method, path }, seconds);
  });
}

// ============================================================================
// tRPC Procedure Metrics
// ============================================================================

/** Matches @trpc/server's ProcedureType. */
export type TrpcProcedureType = "query" | "mutation" | "subscription";

/**
 * Histogram for individual tRPC procedure duration in seconds.
 *
 * This is observed per procedure inside the tRPC timing middleware, so it is
 * accurate even for BATCHED requests — unlike http_request_duration_seconds,
 * which the fetch handler labels with only the first procedure in a batch. Use
 * this for precise per-endpoint latency; use the HTTP histogram for transport
 * overhead. Labels:
 * - procedure: the tRPC path (e.g. "entries.list"); bounded by the router, so
 *   cardinality is safe.
 * - type: "query" | "mutation" | "subscription"
 * - ok: "true" if the procedure resolved, "false" if it errored (so error
 *   latency can be separated from success latency).
 */
const trpcProcedureDurationSeconds = getOrCreate(Histogram, {
  name: "trpc_procedure_duration_seconds",
  help: "tRPC procedure execution duration in seconds, labeled by procedure",
  labelNames: ["procedure", "type", "ok"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export function trackTrpcProcedure(
  procedure: string,
  type: TrpcProcedureType,
  ok: boolean,
  durationMs: number
): void {
  trpcProcedureDurationSeconds?.observe({ procedure, type, ok: String(ok) }, durationMs / 1000);
}

// ============================================================================
// Android App Version Metrics
// ============================================================================

/**
 * Requests made with the Android app's OAuth token, by app version: which
 * installed versions are still in use, so API fields only old installs read can
 * be dropped once they stop showing up (#1846). Counts requests, not installs.
 *
 * The app sends `LionReader-Android/<versionName> (<versionCode>)`; releases
 * up to 0.6.0 send it without ` (<versionCode>)`. Release versionNames are
 * X.Y.Z and versionCodes X*1000000 + Y*1000 + Z
 * (`.github/workflows/android-release.yml`); debug builds' versionCode is 1.
 */
const androidAppRequestsTotal = getOrCreate(Counter, {
  name: "android_app_requests_total",
  help: 'Requests authenticated with the Android app\'s token, by app version ("debug": a debug build; "other": unrecognized User-Agent)',
  labelNames: ["version"] as const,
});

const ANDROID_USER_AGENT =
  /^LionReader-Android\/(\d{1,4})\.(\d{1,3})\.(\d{1,3})(?: \((\d{1,10})\))?$/;

/** The versionCode debug builds report (`kmp/androidApp/build.gradle.kts`). */
const DEBUG_VERSION_CODE = 1;

/**
 * The most distinct versions given their own label, so a client sending
 * made-up version strings can't grow the scrape without bound. Real installs
 * span a handful of releases.
 */
export const MAX_ANDROID_VERSION_LABELS = 50;

/**
 * The versions labeled so far. On `globalThis`, like the registry, so the cap
 * holds per process rather than per module graph.
 */
const VERSIONS_SEEN_KEY = Symbol.for("lion-reader.metrics.android-versions-seen");
type GlobalWithVersionsSeen = typeof globalThis & { [VERSIONS_SEEN_KEY]?: Set<string> };
const androidVersionsSeen: Set<string> = ((globalThis as GlobalWithVersionsSeen)[
  VERSIONS_SEEN_KEY
] ??= new Set<string>());

/**
 * The `version` label for a User-Agent: the app's versionName; "debug" for a
 * debug build; or "other" when the User-Agent isn't the app's, its versionCode
 * doesn't match its versionName, or `seen` already holds the cap of versions.
 * Adds a newly labeled version to `seen`.
 */
export function androidAppVersionLabel(userAgent: string | null, seen: Set<string>): string {
  const match = userAgent?.match(ANDROID_USER_AGENT);
  if (!match) return "other";
  const [, major, minor, patch, code] = match;
  if (code !== undefined) {
    const versionCode = Number(code);
    if (versionCode === DEBUG_VERSION_CODE) return "debug";
    if (versionCode !== Number(major) * 1_000_000 + Number(minor) * 1_000 + Number(patch)) {
      return "other";
    }
  }
  const version = `${Number(major)}.${Number(minor)}.${Number(patch)}`;
  if (seen.has(version)) return version;
  if (seen.size >= MAX_ANDROID_VERSION_LABELS) return "other";
  seen.add(version);
  return version;
}

export function trackAndroidAppRequest(userAgent: string | null): void {
  if (!androidAppRequestsTotal) return;
  androidAppRequestsTotal.inc({ version: androidAppVersionLabel(userAgent, androidVersionsSeen) });
}

// ============================================================================
// Feed Fetch Metrics
// ============================================================================

/** `error` is any failure: network, HTTP or parsing. */
export type FeedFetchStatus = "success" | "not_modified" | "error";

const feedFetchTotal = getOrCreate(Counter, {
  name: "feed_fetch_total",
  help: "Total feed fetch attempts",
  labelNames: ["status"] as const,
});

/** From the request's start until the response is fully processed. */
const feedFetchDurationSeconds = getOrCreate(Histogram, {
  name: "feed_fetch_duration_seconds",
  help: "Feed fetch duration in seconds",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

export function startFeedFetchTimer(): (status: FeedFetchStatus) => void {
  return startTimer((seconds, status: FeedFetchStatus) => {
    feedFetchTotal?.inc({ status });
    feedFetchDurationSeconds?.observe(seconds);
  });
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

// Each times only its own step, not the fetch or processing around it.

export const startFeedParseTimer = histogramTimer(
  getOrCreate(Histogram, {
    name: "feed_parse_duration_seconds",
    help: "Feed parsing (RSS/Atom/JSON) duration in seconds",
    buckets: CONTENT_PROCESSING_BUCKETS,
  })
);

export const startReadabilityTimer = histogramTimer(
  getOrCreate(Histogram, {
    name: "readability_duration_seconds",
    help: "Readability article extraction duration in seconds",
    buckets: CONTENT_PROCESSING_BUCKETS,
  })
);

/** The native render (comrak + MathML), not frontmatter parsing. */
export const startMarkdownRenderTimer = histogramTimer(
  getOrCreate(Histogram, {
    name: "markdown_render_duration_seconds",
    help: "Markdown to HTML rendering duration in seconds",
    buckets: CONTENT_PROCESSING_BUCKETS,
  })
);

export const startSanitizeTimer = histogramTimer(
  getOrCreate(Histogram, {
    name: "sanitize_duration_seconds",
    help: "HTML sanitization duration in seconds",
    buckets: CONTENT_PROCESSING_BUCKETS,
  })
);

// ============================================================================
// Job Processing Metrics
// ============================================================================

/** `failure` may still be retried. */
export type JobStatus = "success" | "failure";

const jobProcessedTotal = getOrCreate(Counter, {
  name: "job_processed_total",
  help: "Total jobs processed",
  labelNames: ["type", "status"] as const,
});

const jobDurationSeconds = getOrCreate(Histogram, {
  name: "job_duration_seconds",
  help: "Job processing duration in seconds",
  labelNames: ["type"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
});

export function trackJobProcessed(type: string, status: JobStatus, durationMs: number): void {
  jobProcessedTotal?.inc({ type, status });
  jobDurationSeconds?.observe({ type }, durationMs / 1000);
}

// ============================================================================
// SSE Connection Metrics
// ============================================================================

const sseConnectionsActive = getOrCreate(Gauge, {
  name: "sse_connections_active",
  help: "Number of active SSE connections",
});

const sseEventsSentTotal = getOrCreate(Counter, {
  name: "sse_events_sent_total",
  help: "Total SSE events sent to clients",
  labelNames: ["type"] as const,
});

export function incrementSSEConnections(): void {
  sseConnectionsActive?.inc();
}

export function decrementSSEConnections(): void {
  sseConnectionsActive?.dec();
}

export function trackSSEEventSent(eventType: string): void {
  sseEventsSentTotal?.inc({ type: eventType });
}

// ============================================================================
// Database Pool Metrics
// ============================================================================

const dbPoolTotalConnections = getOrCreate(Gauge, {
  name: "db_pool_total_connections",
  help: "Total connections in the database pool",
});

const dbPoolIdleConnections = getOrCreate(Gauge, {
  name: "db_pool_idle_connections",
  help: "Idle connections in the database pool",
});

const dbPoolWaitingRequests = getOrCreate(Gauge, {
  name: "db_pool_waiting_requests",
  help: "Requests waiting for a database connection",
});

/** From pg Pool stats. */
export function updateDbPoolMetrics(stats: {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}): void {
  dbPoolTotalConnections?.set(stats.totalCount);
  dbPoolIdleConnections?.set(stats.idleCount);
  dbPoolWaitingRequests?.set(stats.waitingCount);
}

/**
 * Counter for errors raised on idle connections in the database pool, split by
 * whether the connection merely went away (`disconnect`) or something else went
 * wrong (`unexpected`). Disconnects are not reported to Sentry — they are routine
 * and arrive in bursts — so this counter is how they stay visible.
 */
const dbPoolClientErrorsTotal = getOrCreate(Counter, {
  name: "db_pool_client_errors_total",
  help: "Errors on idle database pool connections",
  labelNames: ["reason"] as const,
});

export function trackDbPoolClientError(reason: "disconnect" | "unexpected"): void {
  dbPoolClientErrorsTotal?.inc({ reason });
}

// ============================================================================
// Business Metrics
// ============================================================================

// These gauges describe the whole database, so only the process that collects
// them (see collectAllMetrics) should export them. They're created on first
// update rather than at load: an unset gauge still scrapes as 0, which would
// add a bogus zero series from every other process.

export function updateBusinessMetrics(counts: {
  users: number;
  subscriptions: number;
  entries: number;
  feeds: number;
}): void {
  getOrCreate(Gauge, {
    name: "users_total",
    help: "Total number of registered users",
  })?.set(counts.users);
  getOrCreate(Gauge, {
    name: "subscriptions_total",
    help: "Total number of active subscriptions",
  })?.set(counts.subscriptions);
  getOrCreate(Gauge, {
    name: "entries_total",
    help: "Total number of entries (Postgres planner estimate)",
  })?.set(counts.entries);
  getOrCreate(Gauge, {
    name: "feeds_total",
    help: "Total number of web feeds (the feeds we fetch)",
  })?.set(counts.feeds);
}

export function updateJobQueueMetrics(
  counts: Array<{ type: string; status: string; count: number }>
): void {
  const jobQueueSize = getOrCreate(Gauge, {
    name: "job_queue_size",
    help: "Current job queue size by type and status",
    labelNames: ["type", "status"] as const,
  });
  // Drop groups that no longer appear (e.g. running=1 after the queue drains).
  jobQueueSize?.reset();
  for (const { type, status, count } of counts) {
    jobQueueSize?.set({ type, status }, count);
  }
}

// ============================================================================
// WebSub Metrics
// ============================================================================

const websubNotificationsReceivedTotal = getOrCreate(Counter, {
  name: "websub_notifications_received_total",
  help: "Total WebSub content notifications received",
});

const websubRenewalsTotal = getOrCreate(Counter, {
  name: "websub_renewals_total",
  help: "Total WebSub subscription renewal attempts",
  labelNames: ["status"] as const,
});

export function trackWebsubNotificationReceived(): void {
  websubNotificationsReceivedTotal?.inc();
}

export function trackWebsubRenewal(success: boolean): void {
  websubRenewalsTotal?.inc({ status: success ? "success" : "failure" });
}

// ============================================================================
// Feed Fetch Health Metrics
// ============================================================================

// Both set by the monitor_feed_health job.

/**
 * Alert if this grows beyond the expected fetch cadence (feeds are polled at
 * least hourly in steady state).
 */
const feedLastSuccessfulFetchAgeSeconds = getOrCreate(Gauge, {
  name: "feed_last_successful_fetch_age_seconds",
  help: "Seconds since the most recent successful feed fetch across all pollable feeds",
});

const feedsFailing = getOrCreate(Gauge, {
  name: "feeds_failing",
  help: "Number of pollable feeds with consecutive fetch failures",
});

export function updateFeedHealthMetrics(
  lastSuccessAgeSeconds: number | null,
  failingFeedCount: number
): void {
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
 * `llm`: preprocessed by the narration model (any of `NARRATION_PROVIDERS`);
 * `fallback`: the plain-text conversion.
 */
export type NarrationSource = "llm" | "fallback";

/** `api_error`: the narration model's provider call failed; `empty_response`: it answered nothing. */
export type NarrationErrorType = "api_error" | "empty_response" | "unknown";

const narrationGeneratedTotal = getOrCreate(Counter, {
  name: "narration_generated_total",
  help: "Total narration generations",
  labelNames: ["cached", "source"] as const,
});

const narrationGenerationErrorsTotal = getOrCreate(Counter, {
  name: "narration_generation_errors_total",
  help: "Total narration generation errors",
  labelNames: ["error_type"] as const,
});

export function trackNarrationGenerated(cached: boolean, source: NarrationSource): void {
  narrationGeneratedTotal?.inc({ cached: String(cached), source });
}

export function trackNarrationGenerationError(errorType: NarrationErrorType): void {
  narrationGenerationErrorsTotal?.inc({ error_type: errorType });
}

/** Times only the model's generation, not a fallback or a cache hit. */
export const startNarrationGenerationTimer = histogramTimer(
  getOrCreate(Histogram, {
    name: "narration_generation_duration_seconds",
    help: "Narration generation duration in seconds",
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30],
  })
);

// ============================================================================
// Enhanced Voice Metrics (browser events, through /api/v1/telemetry)
// ============================================================================

const enhancedVoiceSelectedTotal = getOrCreate(Counter, {
  name: "enhanced_voice_selected_total",
  help: "Total enhanced voice selections",
  labelNames: ["voice_id"] as const,
});

const enhancedVoiceModelDownloadCompletedTotal = getOrCreate(Counter, {
  name: "enhanced_voice_model_download_completed_total",
  help: "Total enhanced voice model downloads completed",
});

const enhancedVoiceModelDownloadFailedTotal = getOrCreate(Counter, {
  name: "enhanced_voice_model_download_failed_total",
  help: "Total enhanced voice model download failures",
  labelNames: ["error_type"] as const,
});

const narrationPlaybackStartedTotal = getOrCreate(Counter, {
  name: "narration_playback_started_total",
  help: "Total narration playbacks started",
  labelNames: ["provider"] as const,
});

export function trackEnhancedVoiceSelected(voiceId: string): void {
  enhancedVoiceSelectedTotal?.inc({ voice_id: voiceId });
}

export function trackEnhancedVoiceModelDownloadCompleted(): void {
  enhancedVoiceModelDownloadCompletedTotal?.inc();
}

export function trackEnhancedVoiceModelDownloadFailed(errorType: VoiceDownloadErrorType): void {
  enhancedVoiceModelDownloadFailedTotal?.inc({ error_type: errorType });
}

export function trackNarrationPlaybackStarted(provider: TTSProviderId): void {
  narrationPlaybackStartedTotal?.inc({ provider });
}

// ============================================================================
// Narration Highlighting Metrics
// ============================================================================

/** Highlighting fell back to positional mapping, without the model's markers. */
const narrationHighlightFallbackTotal = getOrCreate(Counter, {
  name: "narration_highlight_fallback_total",
  help: "Total times fallback positional mapping was used for highlighting",
});

export function trackNarrationHighlightFallback(): void {
  narrationHighlightFallbackTotal?.inc();
}
