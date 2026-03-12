/**
 * Benchmark scenario: tags.list (Tier 2 - lower concurrency).
 */

import type { ScenarioConfig } from "../lib/scenario";
import { trpcQuery, type BenchmarkClient } from "../lib/http";

export const tagsList: ScenarioConfig = {
  name: "tags.list",
  concurrency: 5,
  durationMs: 15_000,
  run: async (client: BenchmarkClient) => {
    await trpcQuery(client, "tags.list", {});
  },
};
