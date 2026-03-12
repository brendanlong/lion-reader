/**
 * Benchmark scenario: mixed workload simulating real usage.
 *
 * Weights: 40% entries.list, 20% entries.count, 15% markRead,
 *          10% subscriptions.list, 5% tags.list, 5% sync.events, 5% entries.get
 */

import type { ScenarioConfig } from "../lib/scenario";
import { trpcQuery, trpcMutation, type BenchmarkClient } from "../lib/http";

/** Cache of entry IDs for markRead and entries.get */
let cachedEntryIds: string[] = [];

interface WeightedAction {
  weight: number;
  fn: (client: BenchmarkClient) => Promise<void>;
}

const actions: WeightedAction[] = [
  {
    weight: 40,
    fn: async (client) => {
      await trpcQuery(client, "entries.list", {});
    },
  },
  {
    weight: 20,
    fn: async (client) => {
      await trpcQuery(client, "entries.count", {});
    },
  },
  {
    weight: 15,
    fn: async (client) => {
      if (cachedEntryIds.length === 0) return;
      const id = cachedEntryIds[Math.floor(Math.random() * cachedEntryIds.length)];
      await trpcMutation(client, "entries.markRead", {
        entries: [{ id }],
        read: true,
        fromList: true,
      });
    },
  },
  {
    weight: 10,
    fn: async (client) => {
      await trpcQuery(client, "subscriptions.list", {});
    },
  },
  {
    weight: 5,
    fn: async (client) => {
      await trpcQuery(client, "tags.list", {});
    },
  },
  {
    weight: 5,
    fn: async (client) => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      await trpcQuery(client, "sync.events", { cursor: fiveMinAgo });
    },
  },
  {
    weight: 5,
    fn: async (client) => {
      if (cachedEntryIds.length === 0) return;
      const id = cachedEntryIds[Math.floor(Math.random() * cachedEntryIds.length)];
      await trpcQuery(client, "entries.get", { id });
    },
  },
];

function pickAction(): WeightedAction {
  const total = actions.reduce((sum, a) => sum + a.weight, 0);
  let rand = Math.random() * total;
  for (const action of actions) {
    rand -= action.weight;
    if (rand <= 0) return action;
  }
  return actions[0];
}

export const mixedWorkload: ScenarioConfig = {
  name: "mixed workload",
  concurrency: 10,
  durationMs: 60_000,
  setup: async (client: BenchmarkClient) => {
    const result = (await trpcQuery(client, "entries.list", {
      limit: 50,
    })) as { items: Array<{ id: string }> } | undefined;
    cachedEntryIds = result?.items?.map((e) => e.id) ?? [];
  },
  run: async (client: BenchmarkClient) => {
    const action = pickAction();
    await action.fn(client);
  },
};
