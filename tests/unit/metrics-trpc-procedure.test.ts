/**
 * Unit tests for the per-procedure tRPC latency metric.
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

describe("trpc procedure duration metric", () => {
  it("records a labeled observation per procedure", async () => {
    metrics.trackTrpcProcedure("entries.list", "query", true, 12);

    const output = await metrics.registry.metrics();
    expect(output).toContain("trpc_procedure_duration_seconds_bucket");
    expect(output).toMatch(
      /trpc_procedure_duration_seconds_count\{[^}]*procedure="entries\.list"[^}]*type="query"[^}]*ok="true"[^}]*\} \d+/
    );
  });

  it("separates errored calls via the ok label", async () => {
    metrics.trackTrpcProcedure("subscriptions.create", "mutation", false, 34);

    const output = await metrics.registry.metrics();
    expect(output).toMatch(
      /trpc_procedure_duration_seconds_count\{[^}]*procedure="subscriptions\.create"[^}]*ok="false"[^}]*\} \d+/
    );
  });
});
