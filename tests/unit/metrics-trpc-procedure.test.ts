/**
 * Unit tests for the per-procedure tRPC latency metric.
 *
 * `metricsEnabled` is read from the environment at module load, so we set
 * METRICS_ENABLED before dynamically importing the metrics module.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { Context } from "@/server/trpc/context";

let metrics: typeof import("@/server/metrics/metrics");
let trpc: typeof import("@/server/trpc/trpc");

beforeAll(async () => {
  process.env.METRICS_ENABLED = "true";
  metrics = await import("@/server/metrics/metrics");
  trpc = await import("@/server/trpc/trpc");
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

describe("timingMiddleware records the procedure metric", () => {
  it("observes ok=true on success and ok=false on error, exactly once each", async () => {
    // A real router + real caller exercises the actual middleware wiring — the
    // try/return-vs-catch path that decides the `ok` label (see the comment in
    // trpc.ts). The procedures touch no DB, so a minimal cast context suffices
    // (nothing internal is stubbed).
    const router = trpc.createTRPCRouter({
      metricsWiringOk: trpc.publicProcedure.query(() => "ok"),
      metricsWiringErr: trpc.publicProcedure.query(() => {
        throw new Error("boom");
      }),
    });
    const caller = trpc.createCallerFactory(router)({
      session: null,
      apiToken: null,
      authType: null,
      scopes: [],
      headers: new Headers(),
      sessionToken: null,
    } as unknown as Context);

    await caller.metricsWiringOk();
    await expect(caller.metricsWiringErr()).rejects.toThrow();

    const output = await metrics.registry.metrics();
    // Exactly one observation each — proves no double-count between the try and
    // catch paths, and that a thrown procedure is recorded as ok="false".
    expect(output).toMatch(/procedure="metricsWiringOk"[^}]*ok="true"[^}]*\} 1\b/);
    expect(output).toMatch(/procedure="metricsWiringErr"[^}]*ok="false"[^}]*\} 1\b/);
  });
});
