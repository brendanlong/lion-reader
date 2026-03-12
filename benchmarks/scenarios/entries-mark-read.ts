/**
 * Benchmark scenario: entries.markRead with batches of 1 and 10.
 */

import type { ScenarioConfig } from "../lib/scenario";
import { trpcQuery, trpcMutation, type BenchmarkClient } from "../lib/http";

function createMarkReadScenario(batchSize: number): ScenarioConfig {
  return {
    name: `entries.markRead (batch=${batchSize})`,
    concurrency: 10,
    durationMs: 30_000,
    run: async (client: BenchmarkClient) => {
      // Fetch some entries to get real IDs
      const result = (await trpcQuery(client, "entries.list", {
        limit: batchSize,
      })) as { items: Array<{ id: string }> } | undefined;

      const entries = result?.items?.map((e) => ({ id: e.id })) ?? [];
      if (entries.length === 0) return;

      await trpcMutation(client, "entries.markRead", {
        entries,
        read: true,
        fromList: true,
      });
    },
  };
}

export const markReadBatch1 = createMarkReadScenario(1);
export const markReadBatch10 = createMarkReadScenario(10);
