/**
 * Regression tests for the metrics-registry double-registration crash.
 *
 * In production the Next.js app process evaluates `src/server/metrics/metrics.ts`
 * in MULTIPLE separate module graphs (custom-server bundle, instrumentation
 * hook, and route-handler chunks). The registry is anchored on `globalThis` so
 * all graphs converge on one object, and every metric is created via an
 * idempotent `getOrCreate*` helper so a second module-graph evaluation REUSES
 * the existing metric instead of re-registering it.
 *
 * If a metric is instead created with a raw `new Counter/Histogram/Gauge({
 * registers: [registry] })` (as #1293 did — which, combined with the shared
 * registry from #1296, crashed the whole app and took the site down), the second
 * evaluation throws "A metric with the name X has already been registered".
 *
 * These two tests make that failure show up in CI instead of production:
 * - the behavioral test reproduces the second module-graph evaluation, and
 * - the source guard forbids the raw-constructor pattern outright (the crash
 *   cause is non-obvious, so we stop it at the point of writing).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, vi } from "vitest";

describe("metrics registry survives repeated module evaluation", () => {
  beforeAll(() => {
    // `metricsEnabled` is read at module load; the registration path (and thus
    // the crash) is dead unless metrics are enabled.
    process.env.METRICS_ENABLED = "true";
  });

  it("re-evaluating the metrics module does not throw on duplicate registration", async () => {
    // First evaluation creates the shared (globalThis) registry and registers
    // every metric on it.
    const first = await import("@/server/metrics/metrics");

    // Reset only vitest's module cache. The globalThis registry persists — which
    // is exactly the production condition: a new module graph in the same
    // process, sharing one registry via `Symbol.for`.
    vi.resetModules();

    // Second evaluation must reuse the existing metric objects. If any metric is
    // registered outside the idempotent helpers, this import rejects with
    // "A metric with the name X has already been registered".
    const second = await import("@/server/metrics/metrics");

    // Both evaluations resolve to the same underlying registry (globalThis
    // singleton), and it still scrapes cleanly.
    expect(second.registry).toBe(first.registry);
    await expect(second.registry.metrics()).resolves.toContain("http_requests_total");
  });
});

describe("metrics module constructs metrics only through the idempotent helpers", () => {
  it("has no raw new Counter/Histogram/Gauge outside getOrCreate*", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/server/metrics/metrics.ts", import.meta.url)),
      "utf8"
    );

    // The only legitimate constructions are inside the three getOrCreate*
    // helpers, written as `new Counter<T>(...)` / `new Histogram<T>(...)` /
    // `new Gauge<T>(...)`. Any `new Counter/Histogram/Gauge` NOT immediately
    // followed by `<T>` is a raw registration that reintroduces the crash — use
    // getOrCreateCounter / getOrCreateHistogram / getOrCreateGauge instead.
    const rawConstructions = [...source.matchAll(/new\s+(Counter|Histogram|Gauge)\b(?!<T>)/g)].map(
      (match) => match[0]
    );

    expect(
      rawConstructions,
      "Register metrics via getOrCreate<Counter|Histogram|Gauge>, not a raw prom-client constructor — " +
        "a raw `new X({ registers: [registry] })` crashes the app on the second module-graph evaluation"
    ).toEqual([]);
  });
});
