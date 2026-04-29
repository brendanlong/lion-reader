/**
 * Benchmark scenario: entries.get (Tier 2 - single entry fetch).
 */

import type { ScenarioConfig } from "../lib/scenario";
import { trpcQuery, type BenchmarkClient } from "../lib/http";

/** Cache of entry IDs to avoid fetching them every request */
let cachedEntryIds: string[] = [];

export const entriesGet: ScenarioConfig = {
  name: "entries.get",
  concurrency: 5,
  durationMs: 15_000,
  setup: async (client: BenchmarkClient) => {
    // Pre-fetch a pool of entry IDs to use during the load test
    const result = (await trpcQuery(client, "entries.list", {
      limit: 50,
    })) as { items: Array<{ id: string }> } | undefined;
    cachedEntryIds = result?.items?.map((e) => e.id) ?? [];
  },
  run: async (client: BenchmarkClient) => {
    if (cachedEntryIds.length === 0) return;
    const id = cachedEntryIds[Math.floor(Math.random() * cachedEntryIds.length)];
    await trpcQuery(client, "entries.get", { id });
  },
};
