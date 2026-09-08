/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for useEntryMutations.
 *
 * These render the real hook inside the real tRPC + React Query provider (via
 * `renderHookWithTrpc`), backed by a mock network link. That means the actual
 * mutations fire and the real cache is updated — we assert on the tRPC inputs
 * the hook sends and on the resulting cache state, not on compile-time types.
 *
 * The lower-level cache operations these mutations call are covered separately
 * in tests/unit/frontend/cache/operations.test.ts.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { useEntryMutations } from "@/lib/hooks/useEntryMutations";
import type { BulkUnreadCounts, UnreadCounts } from "@/lib/cache/operations";
import { getEntryMutationTracker } from "@/lib/cache/entry-mutation-tracker";
import { updateEntriesInListCache } from "@/lib/cache/entry-cache";
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

function singleCounts(overrides: Partial<UnreadCounts> = {}): UnreadCounts {
  return {
    all: { unread: 0 },
    starred: { unread: 0 },
    ...overrides,
  };
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

  it("updates the entries.list cache with the winning read state on success", async () => {
    // The list cache is written through the winning-state guard (not
    // unconditionally from each response), so a successful markRead must still
    // reach entries.list. Regression guard for that path.
    const { result, queryClient, callsFor } = renderHookWithTrpc(
      () => ({ mutations: useEntryMutations(), utils: trpc.useUtils() }),
      {
        handlers: {
          "entries.markRead": (input) => {
            const typed = input as { entries: { id: string }[]; read: boolean };
            return {
              entries: typed.entries.map((e) => ({
                id: e.id,
                subscriptionId: "sub-1",
                read: typed.read,
                starred: false,
                type: "web" as const,
                updatedAt: fixedDate,
              })),
              counts: bulkCounts(),
            };
          },
        },
      }
    );

    queryClient.setQueryData([["entries", "list"], { input: { limit: 25 }, type: "infinite" }], {
      pages: [
        {
          items: [{ id: "e1", read: false, starred: false, subscriptionId: "sub-1" }],
          nextCursor: undefined,
        },
      ],
      pageParams: [undefined],
    });

    act(() => {
      result.current.mutations.markRead(["e1"], true);
    });

    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(1));
    await waitFor(() => {
      const data = queryClient.getQueryData<{
        pages: Array<{ items: Array<{ id: string; read: boolean }> }>;
      }>([["entries", "list"], { input: { limit: 25 }, type: "infinite" }]);
      expect(data?.pages[0].items[0].read).toBe(true);
    });
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
              counts: singleCounts({ all: { unread: 4 }, starred: { unread: 7 } }),
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

    // onSuccess ran setCounts against the real cache with the server's numbers.
    await waitFor(() =>
      expect(result.current.utils.entries.count.getData({ starredOnly: true })).toEqual({
        unread: 7,
      })
    );
    expect(result.current.utils.entries.count.getData({})).toEqual({ unread: 4 });
  });

  it("toggleStar unstars an entry that is currently starred", async () => {
    const { result, callsFor } = renderHookWithTrpc(() => useEntryMutations(), {
      handlers: {
        "entries.setStarred": (input) => {
          const typed = input as { id: string; starred: boolean };
          return {
            entry: { id: typed.id, read: false, starred: typed.starred, updatedAt: fixedDate },
            counts: singleCounts(),
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
// Concurrent mutations: the per-QueryClient EntryMutationTracker
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

const listKey = [["entries", "list"], { input: { limit: 25 }, type: "infinite" }];

type ListItem = { id: string; read: boolean; starred: boolean; subscriptionId: string };

function markReadResponse(id: string, state: { read: boolean; starred: boolean }, updatedAt: Date) {
  return {
    entries: [{ id, subscriptionId: "sub-1", type: "web" as const, ...state, updatedAt }],
    counts: bulkCounts(),
  };
}

describe("useEntryMutations concurrent mutations", () => {
  const t1 = new Date("2026-07-05T00:00:01.000Z");
  const t2 = new Date("2026-07-05T00:00:02.000Z");

  function renderTwoInstances(handlers: RenderWithTrpcOptions["handlers"]) {
    // Two hook instances on one QueryClient, like the reader (auto-mark-read)
    // and the list (keyboard toggle) both mounted for the same entry.
    const rendered = renderHookWithTrpc(
      () => ({ reader: useEntryMutations(), list: useEntryMutations(), utils: trpc.useUtils() }),
      { handlers }
    );
    rendered.queryClient.setQueryData(listKey, {
      pages: [
        {
          items: [{ id: "e1", read: false, starred: false, subscriptionId: "sub-1" }],
          nextCursor: undefined,
        },
      ],
      pageParams: [undefined],
    });
    const listItem = () =>
      rendered.queryClient.getQueryData<{ pages: Array<{ items: ListItem[] }> }>(listKey)?.pages[0]
        .items[0];
    return { ...rendered, listItem };
  }

  it("keeps the optimistic state while another instance's mutation is still in flight", async () => {
    const markRead = deferredHandler<ReturnType<typeof markReadResponse>>();
    const { result, listItem, callsFor } = renderTwoInstances({
      "entries.markRead": markRead.handler,
    });

    act(() => {
      result.current.reader.markRead(["e1"], true);
      result.current.list.toggleRead("e1", true);
    });
    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(2));
    expect(listItem()?.read).toBe(false);

    // The first (mark-read) response lands while the mark-unread is pending:
    // with per-instance tracking it would flash the entry to read.
    await act(async () => {
      markRead.calls[0].resolve(markReadResponse("e1", { read: true, starred: false }, t1));
    });
    expect(listItem()?.read).toBe(false);

    await act(async () => {
      markRead.calls[1].resolve(markReadResponse("e1", { read: false, starred: false }, t2));
    });
    await waitFor(() => expect(listItem()?.read).toBe(false));
  });

  it("applies the newest updatedAt when responses complete out of order", async () => {
    const markRead = deferredHandler<ReturnType<typeof markReadResponse>>();
    const { result, listItem, callsFor } = renderTwoInstances({
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

    await waitFor(() => expect(listItem()).toMatchObject({ read: false, starred: true }));
  });

  it("rolls back every written field when concurrent mutations from both instances fail", async () => {
    const markRead = deferredHandler<never>();
    const setStarred = deferredHandler<never>();
    const { result, queryClient, listItem, callsFor } = renderTwoInstances({
      "entries.markRead": markRead.handler,
      "entries.setStarred": setStarred.handler,
    });
    queryClient.setQueryData(listKey, {
      pages: [
        {
          items: [{ id: "e1", read: true, starred: true, subscriptionId: "sub-1" }],
          nextCursor: undefined,
        },
      ],
      pageParams: [undefined],
    });

    act(() => {
      result.current.list.toggleRead("e1", true);
      result.current.reader.unstar("e1");
    });
    await waitFor(() => expect(callsFor("entries.setStarred")).toHaveLength(1));
    expect(listItem()).toMatchObject({ read: false, starred: false });

    await act(async () => {
      markRead.calls[0].reject(new Error("boom"));
    });
    // The first failure alone must not roll anything back.
    expect(listItem()).toMatchObject({ read: false, starred: false });

    await act(async () => {
      setStarred.calls[0].reject(new Error("boom"));
    });
    await waitFor(() => expect(listItem()).toMatchObject({ read: true, starred: true }));
    expect(getEntryMutationTracker(queryClient).hasPending("e1")).toBe(false);
  });

  it("rolls back only the field the failed mutation wrote, keeping a mid-flight SSE change", async () => {
    const setStarred = deferredHandler<never>();
    const { result, queryClient, listItem, callsFor } = renderTwoInstances({
      "entries.setStarred": setStarred.handler,
    });
    const utils = result.current.utils;
    utils.entries.get.setData({ id: "e1" }, {
      entry: { id: "e1", read: false, starred: false, updatedAt: fixedDate },
    } as never);

    act(() => {
      result.current.reader.star("e1");
    });
    await waitFor(() => expect(callsFor("entries.setStarred")).toHaveLength(1));

    // Another device marks the entry read while the star is in flight: the
    // entry_state_changed handler writes read: true to entries.get and lists.
    act(() => {
      utils.entries.get.setData({ id: "e1" }, {
        entry: { id: "e1", read: true, starred: false, updatedAt: fixedDate },
      } as never);
      updateEntriesInListCache(queryClient, ["e1"], { read: true, starred: false });
    });
    await act(async () => {
      setStarred.calls[0].reject(new Error("boom"));
    });

    await waitFor(() => expect(listItem()).toMatchObject({ read: true, starred: false }));
    expect(utils.entries.get.getData({ id: "e1" })?.entry).toMatchObject({
      read: true,
      starred: false,
    });
  });

  it("keeps the successful mutation's state when a concurrent one fails", async () => {
    const markRead = deferredHandler<ReturnType<typeof markReadResponse>>();
    const { result, queryClient, listItem, callsFor } = renderTwoInstances({
      "entries.markRead": markRead.handler,
      "entries.setStarred": (input: { id: string }) => ({
        entry: { id: input.id, read: false, starred: true, updatedAt: t1 },
        counts: singleCounts(),
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

    await waitFor(() => expect(listItem()).toMatchObject({ read: false, starred: true }));
    expect(getEntryMutationTracker(queryClient).hasPending("e1")).toBe(false);
  });

  it("does not overwrite an entries.get that was refetched newer than the response", async () => {
    const markRead = deferredHandler<ReturnType<typeof markReadResponse>>();
    const { result, callsFor } = renderTwoInstances({ "entries.markRead": markRead.handler });
    const utils = result.current.utils;
    utils.entries.get.setData({ id: "e1" }, {
      entry: { id: "e1", read: false, starred: false, updatedAt: fixedDate },
    } as never);

    act(() => {
      result.current.reader.markRead(["e1"], true);
    });
    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(1));

    // A fetch completes mid-flight with state newer than what this mutation
    // will report (e.g. another device already acted on the entry).
    act(() => {
      utils.entries.get.setData({ id: "e1" }, {
        entry: { id: "e1", read: false, starred: true, updatedAt: t2 },
      } as never);
    });
    await act(async () => {
      markRead.calls[0].resolve(markReadResponse("e1", { read: true, starred: false }, t1));
    });

    expect(utils.entries.get.getData({ id: "e1" })?.entry).toMatchObject({
      read: false,
      starred: true,
    });
  });

  it("settles entries the server omitted from the response by rolling them back", async () => {
    const { result, queryClient, callsFor } = renderTwoInstances({
      "entries.markRead": () => markReadResponse("e1", { read: true, starred: false }, t1),
    });
    queryClient.setQueryData(listKey, {
      pages: [
        {
          items: [
            { id: "e1", read: false, starred: false, subscriptionId: "sub-1" },
            { id: "e2", read: false, starred: false, subscriptionId: "sub-1" },
          ],
          nextCursor: undefined,
        },
      ],
      pageParams: [undefined],
    });

    act(() => {
      result.current.list.markRead(["e1", "e2"], true);
    });
    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(1));

    const items = () =>
      queryClient.getQueryData<{ pages: Array<{ items: ListItem[] }> }>(listKey)?.pages[0].items;
    await waitFor(() => expect(items()?.[1].read).toBe(false));
    expect(items()?.[0].read).toBe(true);
    const tracker = getEntryMutationTracker(queryClient);
    expect(tracker.hasPending("e1")).toBe(false);
    expect(tracker.hasPending("e2")).toBe(false);
  });

  it("writes the response's starred state to the lists together with read", async () => {
    const { result, listItem, callsFor } = renderTwoInstances({
      "entries.markRead": () => markReadResponse("e1", { read: true, starred: true }, t1),
    });

    act(() => {
      result.current.list.markRead(["e1"], true);
    });
    await waitFor(() => expect(callsFor("entries.markRead")).toHaveLength(1));

    await waitFor(() => expect(listItem()).toMatchObject({ read: true, starred: true }));
  });
});
