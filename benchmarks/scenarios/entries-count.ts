/**
 * Benchmark scenario: entries.count with various filters.
 */

import type { ScenarioConfig } from "../lib/scenario";
import { trpcQuery, type BenchmarkClient } from "../lib/http";

export const entriesCountNoFilter: ScenarioConfig = {
  name: "entries.count (no filter)",
  concurrency: 10,
  durationMs: 30_000,
  run: async (client: BenchmarkClient) => {
    await trpcQuery(client, "entries.count", {});
  },
};

export const entriesCountUnread: ScenarioConfig = {
  name: "entries.count (unread only)",
  concurrency: 10,
  durationMs: 30_000,
  run: async (client: BenchmarkClient) => {
    await trpcQuery(client, "entries.count", { unreadOnly: true });
  },
};

export function createEntriesCountBySubscription(subscriptionId: string): ScenarioConfig {
  return {
    name: "entries.count (by subscription)",
    concurrency: 10,
    durationMs: 30_000,
    run: async (client: BenchmarkClient) => {
      await trpcQuery(client, "entries.count", { subscriptionId });
    },
  };
}
