/**
 * Benchmark scenario: subscriptions.list
 */

import type { ScenarioConfig } from "../lib/scenario";
import { trpcQuery, type BenchmarkClient } from "../lib/http";

export const subscriptionsList: ScenarioConfig = {
  name: "subscriptions.list",
  concurrency: 10,
  durationMs: 30_000,
  run: async (client: BenchmarkClient) => {
    await trpcQuery(client, "subscriptions.list", {});
  },
};
