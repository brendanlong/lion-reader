/**
 * @vitest-environment jsdom
 */

/**
 * The Saved list is the saved subscription's members (#1846), so the client
 * needs that subscription's id, which doesn't exist until the user's first
 * save. These tests cover learning it from the events that save produces.
 */

import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { trpc } from "@/lib/trpc/client";
import { handleSyncEvent } from "@/lib/cache/event-handlers";
import { useEntryListEntries } from "@/lib/hooks/useLocalEntries";
import { SAVED_SUBSCRIPTION_LIST_INPUT } from "@/lib/queries/saved-subscription";
import { renderHookWithTrpc } from "../../../utils/component-test-helpers";
import {
  createCounts,
  createNewEntryEvent,
  savedSubscriptionRow,
} from "../../../utils/cache-test-helpers";

afterEach(() => {
  cleanup();
});

const SAVED_LIST = { type: "saved", sortOrder: "newest", limit: 10 } as const;

/** A saved article's new_entry; `read` as when saved already read elsewhere. */
function savedEvent(entryId: string, day: number, read = false) {
  return createNewEntryEvent({
    entryId,
    subscriptionId: "sub-saved",
    subscriptionIds: ["sub-saved"],
    counts: createCounts(),
    entry: {
      url: `https://example.com/${entryId}`,
      title: entryId,
      author: null,
      summary: null,
      publishedAt: null,
      fetchedAt: `2024-07-0${day}T00:00:00.000Z`,
      siteName: "Example",
      feedTitle: "Saved Articles",
      type: "saved",
      read,
    },
  });
}

/**
 * The app as it starts before the user has saved anything, with the Saved list
 * loaded (empty). `server.savedSubscriptionId` is the saved subscription the
 * server lists.
 */
async function setup() {
  const server: { savedSubscriptionId: string | null } = { savedSubscriptionId: null };
  const rendered = renderHookWithTrpc(
    () => ({ utils: trpc.useUtils(), saved: useEntryListEntries(SAVED_LIST, null) }),
    {
      handlers: {
        "subscriptions.list": () => ({
          items:
            server.savedSubscriptionId === null
              ? []
              : [savedSubscriptionRow(server.savedSubscriptionId)],
        }),
      },
    }
  );
  const { queryClient, callsFor } = rendered;
  // As in the browser, where a fetch of fresh data serves the cache.
  queryClient.setDefaultOptions({ queries: { staleTime: 60 * 1000 } });
  await act(() =>
    rendered.result.current.utils.subscriptions.list.fetch(SAVED_SUBSCRIPTION_LIST_INPUT)
  );
  act(() => {
    queryClient.setQueryData([["entries", "list"], { input: SAVED_LIST, type: "infinite" }], {
      pages: [{ items: [] }],
      pageParams: [undefined],
    });
  });
  return {
    server,
    queryClient,
    ids: () => rendered.result.current.saved.map((entry) => entry.id),
    lookups: () => callsFor("subscriptions.list").length - 1,
    deliver: (event: ReturnType<typeof savedEvent>) =>
      act(() => handleSyncEvent(rendered.result.current.utils, queryClient, event)),
  };
}

describe("the saved subscription", () => {
  it("is learned from the first save's event, even one already read, which then joins Saved", async () => {
    const { server, ids, lookups, deliver } = await setup();

    server.savedSubscriptionId = "sub-saved";
    deliver(savedEvent("first", 1, true));
    await waitFor(() => expect(ids()).toEqual(["first"]));

    // Once known, later saves join directly.
    deliver(savedEvent("second", 2));
    await waitFor(() => expect(ids()).toEqual(["second", "first"]));
    expect(lookups()).toBe(1);
  });

  it("is looked up at most once per page load while the server names none", async () => {
    const { ids, lookups, deliver } = await setup();

    deliver(savedEvent("first", 1));
    await waitFor(() => expect(lookups()).toBe(1));
    deliver(savedEvent("second", 2));
    await act(async () => {});

    expect(lookups()).toBe(1);
    expect(ids()).toEqual([]);
  });

  it("isn't forgotten by a result fetched before the first save", async () => {
    const { server, queryClient, ids, lookups, deliver } = await setup();
    server.savedSubscriptionId = "sub-saved";
    deliver(savedEvent("first", 1));
    await waitFor(() => expect(ids()).toEqual(["first"]));

    // A listing of saved subscriptions whose fetch predates the save.
    act(() => {
      queryClient.setQueryData(
        [["subscriptions", "list"], { input: SAVED_SUBSCRIPTION_LIST_INPUT, type: "query" }],
        { items: [] }
      );
    });
    deliver(savedEvent("second", 2));

    await waitFor(() => expect(ids()).toEqual(["second", "first"]));
    expect(lookups()).toBe(1);
  });
});
