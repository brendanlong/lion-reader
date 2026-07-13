/**
 * Tests for snapshotEntryGetStates + reconcileListFromChangedEntryGets.
 *
 * A completing `fetchNextPage` replaces the entries.list pages snapshot taken at
 * fetch start, dropping any read/starred writes applied to the old pages while
 * the fetch was in flight (e.g. auto-mark-read fired by j/k navigation). The
 * reconcile snapshots entries.get state at fetch start and, after the fetch
 * settles, re-asserts onto the list only the entries whose entries.get state
 * *changed during the fetch window* — so clobbered mutation writes are restored
 * without resurrecting stale gets (e.g. after mark_all_read, which never touches
 * entries.get). See #1081.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  snapshotEntryGetStates,
  reconcileListFromChangedEntryGets,
  updateEntriesInListCache,
} from "@/lib/cache/entry-cache";
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

describe("reconcileListFromChangedEntryGets", () => {
  it("restores a read flag that changed in entries.get during the fetch window", () => {
    // entry-1 starts unread in both caches.
    expect(listEntry("entry-1")?.read).toBe(false);
    const before = snapshotEntryGetStates(queryClient);

    // Simulate a mid-fetch mark-read whose list write was clobbered by the
    // completing fetchNextPage: only entries.get holds the new state.
    setEntryGet("entry-1", { read: true });

    reconcileListFromChangedEntryGets(queryClient, before);

    expect(listEntry("entry-1")?.read).toBe(true);
    // starred untouched (entry-1 was seeded starred)
    expect(listEntry("entry-1")?.starred).toBe(true);
  });

  it("restores a starred flag that changed in entries.get during the fetch window", () => {
    expect(listEntry("entry-2")?.starred).toBe(false);
    const before = snapshotEntryGetStates(queryClient);

    setEntryGet("entry-2", { starred: true });

    reconcileListFromChangedEntryGets(queryClient, before);

    expect(listEntry("entry-2")?.starred).toBe(true);
  });

  it("does NOT resurrect a stale entries.get that didn't change during the fetch (mark_all_read)", () => {
    // entry-1 unread in both caches. Snapshot at fetch start.
    const before = snapshotEntryGetStates(queryClient);

    // mark_all_read: the list is refetched to read=true, but entries.get is
    // never touched (neither the SSE handler nor the acting mutation updates
    // it), so it stays read=false — stale.
    updateEntriesInListCache(queryClient, ["entry-1"], { read: true });
    expect(listEntry("entry-1")?.read).toBe(true);
    expect(
      getUtilsData<{ entry: { read: boolean } }>(utils.entries.get, { id: "entry-1" })?.entry.read
    ).toBe(false);

    reconcileListFromChangedEntryGets(queryClient, before);

    // The stale get must NOT flip the freshly-refetched list back to unread.
    expect(listEntry("entry-1")?.read).toBe(true);
  });

  it("applies a get that first appeared during the fetch (fresh server read)", () => {
    // Remove entry-2 from entries.get, snapshot (so it's absent from `before`),
    // then have it appear read=true (e.g. opened + auto-marked during the fetch)
    // while its list row was clobbered to read=false.
    setUtilsData(utils.entries.get, { id: "entry-2" }, undefined);
    const before = snapshotEntryGetStates(queryClient);

    setEntryGet("entry-2", { read: true });

    reconcileListFromChangedEntryGets(queryClient, before);

    expect(listEntry("entry-2")?.read).toBe(true);
  });

  it("preserves the object identity of unchanged list rows (keeps memo effective)", () => {
    const beforeEntry2 = listEntry("entry-2");
    const before = snapshotEntryGetStates(queryClient);
    setEntryGet("entry-1", { read: true });

    reconcileListFromChangedEntryGets(queryClient, before);

    expect(listEntry("entry-2")).toBe(beforeEntry2);
  });

  it("is a no-op when nothing changed during the window", () => {
    const before = snapshotEntryGetStates(queryClient);
    const listBefore = queryClient.getQueryData([
      ["entries", "list"],
      { input: { limit: 25 }, type: "infinite" },
    ]);

    reconcileListFromChangedEntryGets(queryClient, before);

    const listAfter = queryClient.getQueryData([
      ["entries", "list"],
      { input: { limit: 25 }, type: "infinite" },
    ]);
    expect(listAfter).toBe(listBefore);
  });
});
