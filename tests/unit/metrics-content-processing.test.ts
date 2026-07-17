/**
 * Unit tests for the content-processing duration metrics (feed parsing,
 * readability extraction, HTML sanitization).
 *
 * `metricsEnabled` is read from the environment at module load, so we set
 * METRICS_ENABLED before dynamically importing the metrics module.
 */
import { describe, it, expect, beforeAll } from "vitest";

let metrics: typeof import("@/server/metrics/metrics");

beforeAll(async () => {
  process.env.METRICS_ENABLED = "true";
  metrics = await import("@/server/metrics/metrics");
});

async function exportedMetrics(): Promise<string> {
  return metrics.registry.metrics();
}

describe("content-processing duration metrics", () => {
  it("records feed parse duration when the timer completes", async () => {
    const stop = metrics.startFeedParseTimer();
    stop();

    const output = await exportedMetrics();
    expect(output).toContain("feed_parse_duration_seconds_bucket");
    expect(output).toMatch(/feed_parse_duration_seconds_count \d+/);
  });

  it("records readability duration when the timer completes", async () => {
    const stop = metrics.startReadabilityTimer();
    stop();

    const output = await exportedMetrics();
    expect(output).toContain("readability_duration_seconds_bucket");
    expect(output).toMatch(/readability_duration_seconds_count \d+/);
  });

  it("records sanitize duration when the timer completes", async () => {
    const stop = metrics.startSanitizeTimer();
    stop();

    const output = await exportedMetrics();
    expect(output).toContain("sanitize_duration_seconds_bucket");
    expect(output).toMatch(/sanitize_duration_seconds_count \d+/);
  });

  it("uses the same buckets across all three histograms", async () => {
    metrics.startFeedParseTimer()();

    const output = await exportedMetrics();
    // A representative bucket from CONTENT_PROCESSING_BUCKETS should be present.
    expect(output).toContain('feed_parse_duration_seconds_bucket{le="0.001"}');
    expect(output).toContain('readability_duration_seconds_bucket{le="0.001"}');
    expect(output).toContain('sanitize_duration_seconds_bucket{le="0.001"}');
  });
});
