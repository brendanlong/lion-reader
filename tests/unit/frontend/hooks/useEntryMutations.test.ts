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
import { renderHookWithTrpc } from "../../../utils/component-test-helpers";

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
