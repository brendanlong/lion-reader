/**
 * Benchmark scenario: entries.list with varying filters.
 */

import type { ScenarioConfig } from "../lib/scenario";
import { trpcQuery, type BenchmarkClient } from "../lib/http";

function entriesListScenario(name: string, input: Record<string, unknown>): ScenarioConfig {
  return {
    name,
    concurrency: 10,
    durationMs: 30_000,
    run: async (client: BenchmarkClient) => {
      await trpcQuery(client, "entries.list", input);
    },
  };
}

export const entriesListNoFilter = entriesListScenario("entries.list (no filter)", {});

export const entriesListUnreadOnly = entriesListScenario("entries.list (unread only)", {
  unreadOnly: true,
});

export const entriesListByTag = entriesListScenario(
  "entries.list (by tag)",
  {} // tagId set during setup
);

export function createEntriesListBySubscription(subscriptionId: string): ScenarioConfig {
  return entriesListScenario("entries.list (by subscription)", {
    subscriptionId,
  });
}

export function createEntriesListByTag(tagId: string): ScenarioConfig {
  return entriesListScenario("entries.list (by tag)", { tagId });
}
