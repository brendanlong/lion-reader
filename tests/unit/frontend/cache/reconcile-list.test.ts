/**
 * Tests for reconcileListReadStarredFromEntryGet.
 *
 * A completing `fetchNextPage` replaces the entries.list pages snapshot taken at
 * fetch start, dropping any read/starred writes applied to the old pages while
 * the fetch was in flight (e.g. auto-mark-read fired by j/k navigation). The
 * reconcile helper re-asserts the authoritative per-entry state from entries.get
 * onto the list caches after the fetch settles (#1081).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { reconcileListReadStarredFromEntryGet } from "@/lib/cache/entry-cache";
import { _resetSubscriptionLookupMap } from "@/lib/cache/count-cache";
import type { TRPCClientUtils } from "@/lib/trpc/client";
import {
  createSeededQueryClient,
  createRealTrpcUtils,
  seedCacheState,
  getUtilsData,
  setUtilsData,
} from "../../../utils/cache-test-helpers";
import type { QueryClient } from "@tanstack/react-query";

let utils: TRPCClientUtils;
let queryClient: QueryClient;

beforeEach(() => {
  _resetSubscriptionLookupMap();
  queryClient = createSeededQueryClient();
  utils = createRealTrpcUtils(queryClient);
  seedCacheState(utils);
});

function listEntry(id: string): { id: string; read: boolean; starred: boolean } | undefined {
  const queries = queryClient.getQueriesData<{
    pages: Array<{ items: Array<{ id: string; read: boolean; starred: boolean }> }>;
  }>({ queryKey: [["entries", "list"]] });
  for (const [, data] of queries) {
    for (const page of data?.pages ?? []) {
      const found = page.items.find((e) => e.id === id);
      if (found) return found;
    }
  }
  return undefined;
}

function setEntryGet(id: string, updates: { read?: boolean; starred?: boolean }): void {
  const current = getUtilsData<{ entry: Record<string, unknown> }>(utils.entries.get, { id });
  if (!current?.entry) throw new Error(`entry ${id} not seeded`);
  setUtilsData(utils.entries.get, { id }, { ...current, entry: { ...current.entry, ...updates } });
}

describe("reconcileListReadStarredFromEntryGet", () => {
  it("restores a read flag clobbered in the list from entries.get", () => {
    // entry-1 starts unread in both caches. Simulate a mark-read whose list
    // write was clobbered by a completing fetchNextPage: only entries.get holds
    // the new state.
    expect(listEntry("entry-1")?.read).toBe(false);
    setEntryGet("entry-1", { read: true });

    reconcileListReadStarredFromEntryGet(queryClient);

    expect(listEntry("entry-1")?.read).toBe(true);
    // starred is untouched (entry-1 was seeded starred)
    expect(listEntry("entry-1")?.starred).toBe(true);
  });

  it("restores a starred flag clobbered in the list from entries.get", () => {
    expect(listEntry("entry-2")?.starred).toBe(false);
    setEntryGet("entry-2", { starred: true });

    reconcileListReadStarredFromEntryGet(queryClient);

    expect(listEntry("entry-2")?.starred).toBe(true);
  });

  it("preserves the object identity of unchanged list rows (keeps memo effective)", () => {
    // Change only entry-1's state; entry-2 must keep its reference so
    // EntryListItem's memo skips re-rendering it.
    const beforeEntry2 = listEntry("entry-2");
    setEntryGet("entry-1", { read: true });

    reconcileListReadStarredFromEntryGet(queryClient);

    expect(listEntry("entry-2")).toBe(beforeEntry2);
  });

  it("is a no-op when list and entries.get already agree", () => {
    // No divergence seeded, so the whole infinite-query object should keep its
    // identity (no needless re-render / structural churn).
    const before = queryClient.getQueryData([
      ["entries", "list"],
      { input: { limit: 25 }, type: "infinite" },
    ]);

    reconcileListReadStarredFromEntryGet(queryClient);

    const after = queryClient.getQueryData([
      ["entries", "list"],
      { input: { limit: 25 }, type: "infinite" },
    ]);
    expect(after).toBe(before);
  });

  it("leaves list rows without an entries.get entry untouched", () => {
    // Remove entry-2 from entries.get, then diverge entry-1. entry-2 must be
    // left exactly as it was.
    setUtilsData(utils.entries.get, { id: "entry-2" }, undefined);
    const beforeEntry2 = listEntry("entry-2");
    setEntryGet("entry-1", { read: true });

    reconcileListReadStarredFromEntryGet(queryClient);

    expect(listEntry("entry-2")).toBe(beforeEntry2);
  });
});
