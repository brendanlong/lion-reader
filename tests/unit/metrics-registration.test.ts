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
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Same key metrics.ts anchors the shared registry on (see getSharedRegistry).
const REGISTRY_SYMBOL = Symbol.for("lion-reader.metrics.registry");

describe("metrics registry survives repeated module evaluation", () => {
  let prevMetricsEnabled: string | undefined;

  beforeAll(() => {
    // `metricsEnabled` is read at module load; the registration path (and thus
    // the crash) is dead unless metrics are enabled.
    prevMetricsEnabled = process.env.METRICS_ENABLED;
    process.env.METRICS_ENABLED = "true";
    // Start from a clean shared registry so this file reproduces a fresh process
    // rather than inheriting one another test file left on globalThis (vitest
    // isolates module caches per file but not globalThis within a worker).
    Reflect.deleteProperty(globalThis, REGISTRY_SYMBOL);
    vi.resetModules();
  });

  afterAll(() => {
    // Don't leak the env mutation into other files sharing this worker.
    if (prevMetricsEnabled === undefined) delete process.env.METRICS_ENABLED;
    else process.env.METRICS_ENABLED = prevMetricsEnabled;
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
    // singleton) and the same metric objects...
    expect(second.registry).toBe(first.registry);
    expect(second.registry.getSingleMetric("http_requests_total")).toBe(
      first.registry.getSingleMetric("http_requests_total")
    );

    // ...so an observation made through the RE-IMPORTED module lands on the
    // registry the first import scrapes. This is the exact symptom that
    // regressed: route handlers (a second module graph) mutating a different
    // registry than the scrape reads.
    second.startHttpTimer("GET", "/regression-probe")(200);
    await expect(first.registry.metrics()).resolves.toContain('path="/regression-probe"');
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
    // The `<\s*T\s*>` tolerance keeps this robust to generic-argument spacing.
    // Scope note: this guard is intentionally file-local — every metric lives in
    // metrics.ts. A raw registration in another file that imports `registry`
    // would also crash and is not covered here.
    const rawConstructions = [
      ...source.matchAll(/new\s+(Counter|Histogram|Gauge)\b(?!<\s*T\s*>)/g),
    ].map((match) => match[0]);

    expect(
      rawConstructions,
      "Register metrics via getOrCreate<Counter|Histogram|Gauge>, not a raw prom-client constructor — " +
        "a raw `new X({ registers: [registry] })` crashes the app on the second module-graph evaluation"
    ).toEqual([]);
  });
});
