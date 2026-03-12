/**
 * Benchmark scenario: sync.events with cursor set 5 minutes in past.
 */

import type { ScenarioConfig } from "../lib/scenario";
import { trpcQuery, type BenchmarkClient } from "../lib/http";

export const syncEvents: ScenarioConfig = {
  name: "sync.events",
  concurrency: 10,
  durationMs: 30_000,
  run: async (client: BenchmarkClient) => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await trpcQuery(client, "sync.events", { cursor: fiveMinAgo });
  },
};
