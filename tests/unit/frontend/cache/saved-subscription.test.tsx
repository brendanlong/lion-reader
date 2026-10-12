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
import { createNewEntryEvent } from "../../../utils/cache-test-helpers";

afterEach(() => {
  cleanup();
});

const SAVED_LIST = { type: "saved", unreadOnly: true, sortOrder: "newest", limit: 10 } as const;

function savedEvent(entryId: string, savedUnread: number) {
  return createNewEntryEvent({
    entryId,
    subscriptionId: "sub-saved",
    subscriptionIds: ["sub-saved"],
    feedType: "saved",
    counts: {
      all: { unread: savedUnread },
      starred: { unread: 0 },
      saved: { unread: savedUnread },
      subscriptions: [],
      tags: [],
    },
    entry: {
      url: `https://example.com/${entryId}`,
      title: entryId,
      author: null,
      summary: null,
      publishedAt: null,
      fetchedAt: `2024-07-0${savedUnread}T00:00:00.000Z`,
      siteName: "Example",
      feedTitle: "Saved Articles",
      type: "saved",
    },
  });
}

describe("the saved subscription", () => {
  it("is learned from the first save's event, which then joins the Saved list", async () => {
    let savedSubscriptionId: string | null = null;
    const rendered = renderHookWithTrpc(
      () => ({ utils: trpc.useUtils(), saved: useEntryListEntries(SAVED_LIST, null) }),
      {
        handlers: {
          "subscriptions.list": () => ({ items: [], savedSubscriptionId }),
        },
      }
    );
    const { queryClient, callsFor } = rendered;
    const ids = () => rendered.result.current.saved.map((entry) => entry.id);
    // The app starts before the user has saved anything.
    await act(() =>
      rendered.result.current.utils.subscriptions.list.fetch(SAVED_SUBSCRIPTION_LIST_INPUT)
    );
    act(() => {
      queryClient.setQueryData([["entries", "list"], { input: SAVED_LIST, type: "infinite" }], {
        pages: [{ items: [] }],
        pageParams: [undefined],
      });
    });

    // The first save creates the saved subscription.
    savedSubscriptionId = "sub-saved";
    act(() => handleSyncEvent(rendered.result.current.utils, queryClient, savedEvent("first", 1)));
    await waitFor(() => expect(ids()).toEqual(["first"]));

    // Once known, later saves join directly.
    act(() => handleSyncEvent(rendered.result.current.utils, queryClient, savedEvent("second", 2)));
    await waitFor(() => expect(ids()).toEqual(["second", "first"]));
    expect(callsFor("subscriptions.list")).toHaveLength(2);
  });
});
