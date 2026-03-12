/**
 * Main benchmark orchestrator.
 *
 * 1. Seeds the database with realistic data
 * 2. Builds the Next.js app
 * 3. Starts the HTTP server
 * 4. Runs all benchmark scenarios under concurrent load
 * 5. Collects metrics and writes results to JSON
 *
 * Usage:
 *   pnpm benchmark           # Full run (seed + build + bench)
 *   pnpm benchmark:run       # Skip seeding (assumes data exists)
 */

import { execSync } from "node:child_process";
import { seed, BENCHMARK_USER_EMAIL, BENCHMARK_USER_PASSWORD } from "./seed";
import { startServer, stopServer } from "./lib/server";
import { createClient, trpcQuery } from "./lib/http";
import { runLoad } from "./lib/load";
import { computeStats } from "./lib/stats";
import { startMemoryMonitor } from "./lib/memory";
import { writeResults, type ScenarioResult, type BenchmarkResult } from "./lib/results";
import type { ScenarioConfig } from "./lib/scenario";

// Import scenarios
import {
  entriesListNoFilter,
  entriesListUnreadOnly,
  createEntriesListBySubscription,
  createEntriesListByTag,
} from "./scenarios/entries-list";
import { markReadBatch1, markReadBatch10 } from "./scenarios/entries-mark-read";
import {
  entriesCountNoFilter,
  entriesCountUnread,
  createEntriesCountBySubscription,
} from "./scenarios/entries-count";
import { subscriptionsList } from "./scenarios/subscriptions-list";
import { syncEvents } from "./scenarios/sync-events";
import { tagsList } from "./scenarios/tags-list";
import { entriesGet } from "./scenarios/entries-get";
import { mixedWorkload } from "./scenarios/mixed-workload";

// ============================================================================
// Main
// ============================================================================

async function main() {
  const skipSeed = process.argv.includes("--skip-seed");
  const skipBuild = process.argv.includes("--skip-build");

  // Step 1: Seed database
  if (!skipSeed) {
    console.log("\n=== Seeding database ===\n");
    await seed();
  } else {
    console.log("\n=== Skipping seed (--skip-seed) ===\n");
  }

  // Step 2: Build the app
  if (!skipBuild) {
    console.log("\n=== Building Next.js app ===\n");
    execSync("pnpm build", { stdio: "inherit", cwd: process.cwd() });
  } else {
    console.log("\n=== Skipping build (--skip-build) ===\n");
  }

  // Step 3: Start server
  console.log("\n=== Starting server ===\n");
  const server = await startServer();
  console.log(`Server started (PID: ${server.pid})`);

  // Start memory monitoring
  const memMonitor = startMemoryMonitor(server.pid, 2000);

  try {
    // Step 4: Authenticate
    console.log("\n=== Authenticating ===\n");
    const client = await createClient(BENCHMARK_USER_EMAIL, BENCHMARK_USER_PASSWORD);
    console.log("Authenticated successfully");

    // Step 5: Discover dynamic IDs for parameterized scenarios
    const subResult = (await trpcQuery(client, "subscriptions.list", {})) as
      | { items: Array<{ id: string }> }
      | undefined;
    const firstSubId = subResult?.items?.[0]?.id;

    const tagsResult = (await trpcQuery(client, "tags.list", {})) as
      | Array<{ id: string }>
      | undefined;
    const firstTagId = tagsResult?.[0]?.id;

    // Build scenario list
    const scenarios: ScenarioConfig[] = [
      // Tier 1 (10 concurrent, 30s)
      entriesListNoFilter,
      entriesListUnreadOnly,
      ...(firstSubId ? [createEntriesListBySubscription(firstSubId)] : []),
      ...(firstTagId ? [createEntriesListByTag(firstTagId)] : []),
      markReadBatch1,
      markReadBatch10,
      entriesCountNoFilter,
      entriesCountUnread,
      ...(firstSubId ? [createEntriesCountBySubscription(firstSubId)] : []),
      subscriptionsList,
      syncEvents,

      // Tier 2 (5 concurrent, 15s)
      entriesGet,
      tagsList,

      // Mixed (10 concurrent, 60s)
      mixedWorkload,
    ];

    // Step 6: Run scenarios
    const results: ScenarioResult[] = [];

    for (const scenario of scenarios) {
      console.log(
        `\n--- ${scenario.name} (${scenario.concurrency} concurrent, ${scenario.durationMs / 1000}s) ---`
      );

      // Run setup if defined
      if (scenario.setup) {
        await scenario.setup(client);
      }

      const loadResult = await runLoad({
        concurrency: scenario.concurrency,
        durationMs: scenario.durationMs,
        fn: () => scenario.run(client),
      });

      const stats = computeStats(loadResult.latencies);
      const qps = loadResult.durationMs > 0 ? (stats.count / loadResult.durationMs) * 1000 : 0;

      results.push({
        name: scenario.name,
        latency: stats,
        qps: Math.round(qps * 100) / 100,
        errors: loadResult.errors,
        durationMs: loadResult.durationMs,
      });

      console.log(
        `  p50=${stats.p50}ms p95=${stats.p95}ms p99=${stats.p99}ms ` +
          `qps=${qps.toFixed(1)} errors=${loadResult.errors} count=${stats.count}`
      );
    }

    // Step 7: Collect results
    const memorySamples = memMonitor.stop();

    // Stop server and get peak RSS
    await stopServer(server);
    const peakRssKb = await server.peakRssPromise;

    // Get git info
    const commitSha = getGitSha();
    const commitDate = getGitDate();

    const benchmarkResult: BenchmarkResult = {
      commitSha,
      commitDate,
      runDate: new Date().toISOString(),
      scenarios: results,
      peakRssKb,
      memoryTimeSeries: memorySamples,
    };

    // Step 8: Write results
    const filepath = await writeResults(benchmarkResult);
    console.log(`\n=== Results written to ${filepath} ===`);

    // Print summary
    console.log("\n=== Summary ===\n");
    console.log(`Commit: ${commitSha}`);
    console.log(`Peak RSS: ${peakRssKb ? `${peakRssKb} KB` : "N/A"}`);
    console.log(`Memory samples: ${memorySamples.length}`);
    console.log("\nScenario Results:");
    for (const r of results) {
      console.log(
        `  ${r.name.padEnd(40)} p50=${String(r.latency.p50).padStart(5)}ms  ` +
          `p95=${String(r.latency.p95).padStart(5)}ms  ` +
          `qps=${String(r.qps).padStart(7)}  ` +
          `errors=${r.errors}`
      );
    }
  } catch (error) {
    memMonitor.stop();
    await stopServer(server);
    throw error;
  }
}

function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function getGitDate(): string {
  try {
    return execSync("git log -1 --format=%cI", { encoding: "utf-8" }).trim();
  } catch {
    return new Date().toISOString();
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
