/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for useEntryMutations.
 *
 * These render the real hook inside the real tRPC + React Query provider (via
 * `renderHookWithTrpc`), backed by a mock network link. That means the actual
 * mutations fire and the real local entry store and query cache are updated —
 * we assert on the tRPC inputs the hook sends and on the resulting state, not
 * on compile-time types.
 *
 * The lower-level cache operations these mutations call are covered separately
 * in tests/unit/frontend/cache/operations.test.ts.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { useEntryMutations } from "@/lib/hooks/useEntryMutations";
import type { BulkUnreadCounts } from "@/lib/cache/operations";
import { getLocalDb } from "@/lib/local-db/local-db";
import { useEntryListEntries } from "@/lib/hooks/useLocalEntries";
import { setServerEntryState, upsertServerEntries, type EntryRow } from "@/lib/local-db/entries";
import {
  renderHookWithTrpc,
  type RenderWithTrpcOptions,
} from "../../../utils/component-test-helpers";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const fixedDate = new Date("2026-07-05T00:00:00.000Z");

function bulkCounts(overrides: Partial<BulkUnreadCounts> = {}): BulkUnreadCounts {
  return {
    all: { unread: 0 },
    starred: { unread: 0 },
    saved: { unread: 0 },
    subscriptions: [],
    tags: [],
    ...overrides,
  };
}

const t1 = new Date("2026-07-05T00:00:01.000Z");
const t2 = new Date("2026-07-05T00:00:02.000Z");

function markReadResponse(id: string, state: { read: boolean; starred: boolean }, updatedAt: Date) {
  return {
    entries: [{ id, subscriptionId: "sub-1", type: "web" as const, ...state, updatedAt }],
    counts: bulkCounts(),
  };
}

/** Stores an entry as if a fetch had returned it. */
function seedEntry(queryClient: QueryClient, overrides: Partial<EntryRow> = {}): void {
  upsertServerEntries(getLocalDb(queryClient).entries, [
    {
      id: "e1",
      feedId: "feed-1",
      subscriptionId: "sub-1",
      type: "web",
      url: null,
      title: "Entry",
      author: null,
      summary: null,
      publishedAt: fixedDate,
      fetchedAt: fixedDate,
      updatedAt: fixedDate,
      read: false,
      starred: false,
      feedTitle: null,
      siteName: null,
      ...overrides,
    },
  ]);
}

/** The entry as rendered: server state with any pending optimistic change on top. */
function storedEntry(queryClient: QueryClient, id = "e1"): EntryRow | undefined {
  return getLocalDb(queryClient).entries.collection.get(id);
}

describe("useEntryMutations markRead", () => {
  it("calls entries.markRead with the given ids and read status", async () => {
    const markRead = vi.fn((input: { entries: { id: string }[]; read: boolean }) => ({
      entries: input.entries.map((e) => ({
        id: e.id,
        read: input.read,
        starred: false,
        updatedAt: fixedDate,
      })),
      counts: bulkCounts(),
    }));

    const { result, callsFor } = renderHookWithTrpc(
      () => ({ mutations: useEntryMutations(), utils: trpc.useUtils() }),
      { handlers: { "entries.markRead": (input) => markRead(input as never) } }
    );

    act(() => {
      result.current.mutations.markRead(["e1", "e2"], true);
    });

    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(1));

    const input = callsFor("entries.markRead")[0].input as {
      entries: { id: string; changedAt: Date }[];
      read: boolean;
    };
    expect(input.read).toBe(true);
    expect(input.entries.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(input.entries[0].changedAt).toBeInstanceOf(Date);
  });

  it("applies the server's absolute counts to the cache on success", async () => {
    // Distinctive non-zero counts so a no-op/broken onSuccess (React Query
    // swallows onSuccess throws) can't pass — the cache would stay undefined.
    const counts = bulkCounts({
      all: { unread: 5 },
      starred: { unread: 3 },
      saved: { unread: 2 },
    });

    const { result, callsFor } = renderHookWithTrpc(
      () => ({ mutations: useEntryMutations(), utils: trpc.useUtils() }),
      {
        handlers: {
          "entries.markRead": (input) => {
            const typed = input as { entries: { id: string }[]; read: boolean };
            return {
              entries: typed.entries.map((e) => ({
                id: e.id,
                read: typed.read,
                starred: false,
                updatedAt: fixedDate,
              })),
              counts,
            };
          },
        },
      }
    );

    act(() => {
      result.current.mutations.markRead(["e1"], true);
    });

    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(1));
    await waitFor(() =>
      expect(result.current.utils.entries.count.getData({})).toEqual({ unread: 5 })
    );
    expect(result.current.utils.entries.count.getData({ starredOnly: true })).toEqual({
      unread: 3,
    });
    expect(result.current.utils.entries.count.getData({ type: "saved" })).toEqual({ unread: 2 });
  });

  it("writes the server's read state to the entry store on success", async () => {
    const { result, queryClient, callsFor } = renderHookWithTrpc(
      () => ({ mutations: useEntryMutations(), utils: trpc.useUtils() }),
      {
        handlers: {
          "entries.markRead": () => markReadResponse("e1", { read: true, starred: false }, t1),
        },
      }
    );
    seedEntry(queryClient, { read: false });

    act(() => {
      result.current.mutations.markRead(["e1"], true);
    });

    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(1));
    await waitFor(() =>
      expect(storedEntry(queryClient)).toMatchObject({ read: true, updatedAt: t1 })
    );
  });

  it("toggleRead sends the negation of the current read status for a single entry", async () => {
    const { result, callsFor } = renderHookWithTrpc(
      () => ({ mutations: useEntryMutations(), utils: trpc.useUtils() }),
      {
        handlers: {
          "entries.markRead": (input) => {
            const typed = input as { entries: { id: string }[]; read: boolean };
            return {
              entries: typed.entries.map((e) => ({
                id: e.id,
                read: typed.read,
                starred: false,
                updatedAt: fixedDate,
              })),
              counts: bulkCounts(),
            };
          },
        },
      }
    );

    act(() => {
      result.current.mutations.toggleRead("e1", false);
    });

    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(1));
    const input = callsFor("entries.markRead")[0].input as {
      entries: { id: string }[];
      read: boolean;
    };
    expect(input.read).toBe(true);
    expect(input.entries).toEqual([expect.objectContaining({ id: "e1" })]);
  });

  it("shows a toast when the mutation fails", async () => {
    const { result } = renderHookWithTrpc(() => useEntryMutations(), {
      handlers: {
        "entries.markRead": () => {
          throw new Error("boom");
        },
      },
    });

    act(() => {
      result.current.markRead(["e1"], true);
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to update read status"));
  });
});

describe("useEntryMutations markAllRead", () => {
  it("calls entries.markAllRead with the provided filter options", async () => {
    const { result, callsFor } = renderHookWithTrpc(() => useEntryMutations(), {
      handlers: { "entries.markAllRead": () => ({ success: true }) },
    });

    act(() => {
      result.current.markAllRead({ subscriptionId: "sub-1", type: "web" });
    });

    await waitFor(() => expect(callsFor("entries.markAllRead")).toHaveLength(1));
    const input = callsFor("entries.markAllRead")[0].input as {
      subscriptionId?: string;
      type?: string;
      changedAt: Date;
    };
    expect(input.subscriptionId).toBe("sub-1");
    expect(input.type).toBe("web");
    expect(input.changedAt).toBeInstanceOf(Date);
  });

  it("shows a toast when markAllRead fails", async () => {
    const { result } = renderHookWithTrpc(() => useEntryMutations(), {
      handlers: {
        "entries.markAllRead": () => {
          throw new Error("boom");
        },
      },
    });

    act(() => {
      result.current.markAllRead();
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to mark all as read"));
  });
});

describe("useEntryMutations star/unstar", () => {
  it("star calls entries.setStarred with starred: true and applies counts on success", async () => {
    const { result, callsFor } = renderHookWithTrpc(
      () => ({ mutations: useEntryMutations(), utils: trpc.useUtils() }),
      {
        handlers: {
          "entries.setStarred": (input) => {
            const typed = input as { id: string; starred: boolean };
            return {
              entry: { id: typed.id, read: false, starred: typed.starred, updatedAt: fixedDate },
              counts: bulkCounts({ all: { unread: 4 }, starred: { unread: 7 } }),
            };
          },
        },
      }
    );

    act(() => {
      result.current.mutations.star("e1");
    });

    await waitFor(() => expect(callsFor("entries.setStarred")).toHaveLength(1));
    const input = callsFor("entries.setStarred")[0].input as {
      id: string;
      starred: boolean;
      changedAt: Date;
    };
    expect(input).toEqual(
      expect.objectContaining({ id: "e1", starred: true, changedAt: expect.any(Date) })
    );

    // onSuccess ran setBulkCounts against the real cache with the server's numbers.
    await waitFor(() =>
      expect(result.current.utils.entries.count.getData({ starredOnly: true })).toEqual({
        unread: 7,
      })
    );
    expect(result.current.utils.entries.count.getData({})).toEqual({ unread: 4 });
  });

  it("skips a previous-release single-subscription counts shape without failing", async () => {
    // During a canary/rollback window the server may still return the old
    // setStarred counts shape (no `subscriptions` array). The hook must skip it
    // (the entry_state_changed event sets the counts) rather than throw.
    const { result, queryClient, callsFor } = renderHookWithTrpc(
      () => ({ mutations: useEntryMutations(), utils: trpc.useUtils() }),
      {
        handlers: {
          "entries.setStarred": (input) => {
            const typed = input as { id: string; starred: boolean };
            return {
              entry: { id: typed.id, read: false, starred: typed.starred, updatedAt: fixedDate },
              counts: {
                all: { unread: 4 },
                starred: { unread: 7 },
                subscription: { id: "sub-1", unread: 2 },
              } as never,
            };
          },
        },
      }
    );

    act(() => {
      result.current.mutations.star("e1");
    });

    await waitFor(() => expect(callsFor("entries.setStarred")).toHaveLength(1));
    // The mutation settled successfully...
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    // ...without an error toast or any counts written from the old shape.
    expect(toast.error).not.toHaveBeenCalled();
    expect(result.current.utils.entries.count.getData({ starredOnly: true })).toBeUndefined();
    expect(result.current.utils.entries.count.getData({})).toBeUndefined();
  });

  it("toggleStar unstars an entry that is currently starred", async () => {
    const { result, callsFor } = renderHookWithTrpc(() => useEntryMutations(), {
      handlers: {
        "entries.setStarred": (input) => {
          const typed = input as { id: string; starred: boolean };
          return {
            entry: { id: typed.id, read: false, starred: typed.starred, updatedAt: fixedDate },
            counts: bulkCounts(),
          };
        },
      },
    });

    act(() => {
      result.current.toggleStar("e1", true);
    });

    await waitFor(() => expect(callsFor("entries.setStarred")).toHaveLength(1));
    const input = callsFor("entries.setStarred")[0].input as { starred: boolean };
    expect(input.starred).toBe(false);
  });

  it("shows a star-specific toast when the mutation fails", async () => {
    const { result } = renderHookWithTrpc(() => useEntryMutations(), {
      handlers: {
        "entries.setStarred": () => {
          throw new Error("boom");
        },
      },
    });

    act(() => {
      result.current.star("e1");
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to star entry"));
  });
});

// ============================================================================
// Concurrent mutations: TanStack DB transactions over the shared entry store
// ============================================================================

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/** Handler whose responses the test releases one at a time, in any order. */
function deferredHandler<T>(): { handler: () => Promise<T>; calls: Deferred<T>[] } {
  const calls: Deferred<T>[] = [];
  const handler = () =>
    new Promise<T>((resolve, reject) => {
      calls.push({ resolve, reject });
    });
  return { handler, calls };
}

describe("useEntryMutations concurrent mutations", () => {
  function renderTwoInstances(handlers: RenderWithTrpcOptions["handlers"]) {
    // Two hook instances on one QueryClient, like the reader (auto-mark-read)
    // and the list (keyboard toggle) both mounted for the same entry.
    const rendered = renderHookWithTrpc(
      () => ({ reader: useEntryMutations(), list: useEntryMutations(), utils: trpc.useUtils() }),
      { handlers }
    );
    seedEntry(rendered.queryClient, { read: false, starred: false });
    return { ...rendered, entry: () => storedEntry(rendered.queryClient) };
  }

  it("keeps the optimistic state while another instance's mutation is still in flight", async () => {
    const markRead = deferredHandler<ReturnType<typeof markReadResponse>>();
    const { result, entry, callsFor } = renderTwoInstances({
      "entries.markRead": markRead.handler,
    });

    act(() => {
      result.current.reader.markRead(["e1"], true);
      result.current.list.toggleRead("e1", true);
    });
    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(2));
    expect(entry()?.read).toBe(false);

    // The first (mark-read) response lands while the mark-unread is pending:
    // the pending mark-unread must keep showing, not flash the entry to read.
    await act(async () => {
      markRead.calls[0].resolve(markReadResponse("e1", { read: true, starred: false }, t1));
    });
    expect(entry()?.read).toBe(false);

    await act(async () => {
      markRead.calls[1].resolve(markReadResponse("e1", { read: false, starred: false }, t2));
    });
    await waitFor(() => expect(entry()?.read).toBe(false));
  });

  it("applies the newest updatedAt when responses complete out of order", async () => {
    const markRead = deferredHandler<ReturnType<typeof markReadResponse>>();
    const { result, entry, callsFor } = renderTwoInstances({
      "entries.markRead": markRead.handler,
    });

    act(() => {
      result.current.reader.markRead(["e1"], true);
      result.current.list.toggleRead("e1", true);
    });
    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(2));

    // The newest response also reports starred: true (starred elsewhere), so
    // the final state differs from the optimistic one and proves it was
    // written — not merely that nothing overwrote the optimistic write.
    await act(async () => {
      markRead.calls[1].resolve(markReadResponse("e1", { read: false, starred: true }, t2));
    });
    await act(async () => {
      markRead.calls[0].resolve(markReadResponse("e1", { read: true, starred: false }, t1));
    });

    await waitFor(() => expect(entry()).toMatchObject({ read: false, starred: true }));
  });

  it("rolls back every written field when concurrent mutations from both instances fail", async () => {
    const markRead = deferredHandler<never>();
    const setStarred = deferredHandler<never>();
    const { result, queryClient, entry, callsFor } = renderTwoInstances({
      "entries.markRead": markRead.handler,
      "entries.setStarred": setStarred.handler,
    });
    seedEntry(queryClient, { read: true, starred: true });

    act(() => {
      result.current.list.toggleRead("e1", true);
      result.current.reader.unstar("e1");
    });
    await waitFor(() => expect(callsFor("entries.setStarred")).toHaveLength(1));
    expect(entry()).toMatchObject({ read: false, starred: false });

    await act(async () => {
      markRead.calls[0].reject(new Error("boom"));
    });
    // The first failure alone must not roll anything back: the pending unstar
    // still shows the state as of when it was made.
    expect(entry()).toMatchObject({ read: false, starred: false });

    await act(async () => {
      setStarred.calls[0].reject(new Error("boom"));
    });
    await waitFor(() => expect(entry()).toMatchObject({ read: true, starred: true }));
  });

  it("rolls back to the newest server state, keeping a mid-flight SSE change", async () => {
    const setStarred = deferredHandler<never>();
    const { result, queryClient, entry, callsFor } = renderTwoInstances({
      "entries.setStarred": setStarred.handler,
    });

    act(() => {
      result.current.reader.star("e1");
    });
    await waitFor(() => expect(callsFor("entries.setStarred")).toHaveLength(1));

    // Another device marks the entry read while the star is in flight.
    act(() => {
      setServerEntryState(getLocalDb(queryClient).entries, "e1", {
        read: true,
        starred: false,
        updatedAt: t1,
      });
    });

    await act(async () => {
      setStarred.calls[0].reject(new Error("boom"));
    });
    await waitFor(() => expect(entry()).toMatchObject({ read: true, starred: false }));
  });

  it("keeps the successful mutation's state when a concurrent one fails", async () => {
    const markRead = deferredHandler<ReturnType<typeof markReadResponse>>();
    const { result, entry, callsFor } = renderTwoInstances({
      "entries.markRead": markRead.handler,
      "entries.setStarred": (input: { id: string }) => ({
        entry: { id: input.id, read: false, starred: true, updatedAt: t1 },
        counts: bulkCounts(),
      }),
    });

    act(() => {
      result.current.reader.markRead(["e1"], true);
      result.current.list.toggleStar("e1", false);
    });
    await waitFor(() => expect(callsFor("entries.setStarred")).toHaveLength(1));
    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(1));

    await act(async () => {
      markRead.calls[0].reject(new Error("boom"));
    });

    await waitFor(() => expect(entry()).toMatchObject({ read: false, starred: true }));
  });

  it("does not overwrite state a fetch stored newer than the response", async () => {
    const markRead = deferredHandler<ReturnType<typeof markReadResponse>>();
    const { result, queryClient, entry, callsFor } = renderTwoInstances({
      "entries.markRead": markRead.handler,
    });

    act(() => {
      result.current.reader.markRead(["e1"], true);
    });
    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(1));

    // A fetch completes mid-flight with state newer than what this mutation
    // will report (e.g. another device already acted on the entry).
    act(() => {
      seedEntry(queryClient, { read: false, starred: true, updatedAt: t2 });
    });
    await act(async () => {
      markRead.calls[0].resolve(markReadResponse("e1", { read: true, starred: false }, t1));
    });

    await waitFor(() => expect(entry()).toMatchObject({ read: false, starred: true }));
  });

  it("does not let a page fetched before the mutation revert it (#1081)", async () => {
    const markRead = deferredHandler<ReturnType<typeof markReadResponse>>();
    const { result, queryClient, entry, callsFor } = renderTwoInstances({
      "entries.markRead": markRead.handler,
    });

    act(() => {
      result.current.reader.markRead(["e1"], true);
    });
    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(1));
    await act(async () => {
      markRead.calls[0].resolve(markReadResponse("e1", { read: true, starred: false }, t1));
    });

    // A next-page fetch that started before the mark-read lands afterwards,
    // carrying the entry's pre-mutation state.
    act(() => {
      seedEntry(queryClient, { read: false, updatedAt: fixedDate });
    });
    expect(entry()).toMatchObject({ read: true });
  });

  it("rolls back entries the server omitted from the response", async () => {
    const { result, queryClient, callsFor } = renderTwoInstances({
      "entries.markRead": () => markReadResponse("e1", { read: true, starred: false }, t1),
    });
    seedEntry(queryClient, { id: "e2", read: false });

    act(() => {
      result.current.list.markRead(["e1", "e2"], true);
    });
    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(1));

    await waitFor(() => expect(storedEntry(queryClient, "e2")?.read).toBe(false));
    expect(storedEntry(queryClient, "e1")?.read).toBe(true);
  });

  it("writes the response's starred state together with read", async () => {
    const { result, entry, callsFor } = renderTwoInstances({
      "entries.markRead": () => markReadResponse("e1", { read: true, starred: true }, t1),
    });

    act(() => {
      result.current.list.markRead(["e1"], true);
    });
    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(1));

    await waitFor(() => expect(entry()).toMatchObject({ read: true, starred: true }));
  });

  it("still sends a mark-read that changes nothing locally (already-read entry)", async () => {
    const { result, queryClient, callsFor } = renderTwoInstances({
      "entries.markRead": () => markReadResponse("e1", { read: true, starred: false }, t1),
    });
    seedEntry(queryClient, { read: true });

    act(() => {
      result.current.list.markRead(["e1", "not-held"], true);
    });

    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(1));
    const input = callsFor("entries.markRead")[0].input as { entries: { id: string }[] };
    expect(input.entries.map((e) => e.id)).toEqual(["e1", "not-held"]);
  });

  it("inserts an entry marked unread into the unread-only lists missing it", async () => {
    const unreadOnly = { unreadOnly: true, sortOrder: "newest", limit: 10 } as const;
    const { result, queryClient } = renderHookWithTrpc(
      () => ({ mutations: useEntryMutations(), list: useEntryListEntries(unreadOnly, null) }),
      {
        handlers: {
          "entries.markRead": () => markReadResponse("e1", { read: false, starred: false }, t1),
        },
      }
    );
    seedEntry(queryClient, { read: true });
    act(() => {
      queryClient.setQueryData([["entries", "list"], { input: unreadOnly, type: "infinite" }], {
        pages: [{ items: [], nextCursor: undefined }],
        pageParams: [undefined],
      });
    });

    act(() => {
      result.current.mutations.markRead(["e1"], false);
    });

    await waitFor(() => expect(result.current.list).toMatchObject([{ id: "e1", read: false }]));
  });
});
