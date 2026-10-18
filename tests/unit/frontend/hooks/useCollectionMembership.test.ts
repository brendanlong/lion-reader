/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from "vitest";
import { act } from "@testing-library/react";
import { useCollectionMembership } from "@/lib/hooks/useCollectionMembership";
import { renderHookWithTrpc } from "../../../utils/component-test-helpers";
import { getLocalDb } from "@/lib/local-db/local-db";
import { upsertServerEntries } from "@/lib/local-db/entries";
import {
  createSubscriptionRow,
  DEFAULT_ENTRIES,
  savedSubscriptionRow,
} from "../../../utils/cache-test-helpers";
import { writeLiveSubscriptions } from "@/lib/local-db/subscriptions";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const EXISTING = {
  id: "collection-1",
  type: "collection" as const,
  url: null,
  title: "Reading",
  originalTitle: "Reading",
  description: null,
  siteUrl: null,
  subscribedAt: new Date("2026-01-01"),
  unreadCount: 3,
  tags: [],
  fetchFullContent: false,
};
const NO_COUNTS = { subscriptions: [], tags: [], uncategorized: null, all: null };

describe("useCollectionMembership.collectionIds", () => {
  it("is the stored entry's memberships other than its origin, Saved and other feeds", async () => {
    const { result, queryClient } = renderHookWithTrpc(() => useCollectionMembership("entry-1"), {
      handlers: {
        "subscriptions.list": () => ({ items: [savedSubscriptionRow("saved-sub")] }),
      },
    });
    expect(result.current.collectionIds).toBeUndefined();

    act(() =>
      upsertServerEntries(getLocalDb(queryClient).entries, [
        {
          ...DEFAULT_ENTRIES[0],
          id: "entry-1",
          subscriptionId: "sub-1",
          subscriptionIds: ["sub-1", "collection-1", "saved-sub", "collection-2", "merged-feed"],
        },
      ])
    );
    act(() =>
      writeLiveSubscriptions(getLocalDb(queryClient).subscriptions, [
        createSubscriptionRow({ id: "merged-feed", type: "web" }),
      ])
    );

    await vi.waitFor(() =>
      expect(result.current.collectionIds).toEqual(["collection-1", "collection-2"])
    );
  });
});

describe("useCollectionMembership.createWithEntry", () => {
  it("adds the entry to an existing collection the create returned (#1846)", async () => {
    const { result, callsFor } = renderHookWithTrpc(() => useCollectionMembership("entry-1"), {
      handlers: {
        "collections.create": () => ({ subscription: EXISTING, counts: NO_COUNTS, created: false }),
        "collections.addEntries": () => ({ entryIds: ["entry-1"] }),
      },
    });

    let returned: { id: string } | null = null;
    await act(async () => {
      returned = await result.current.createWithEntry("reading");
    });

    expect(returned).toMatchObject({ id: EXISTING.id });
    expect(callsFor("collections.addEntries").map((c) => c.input)).toEqual([
      { id: EXISTING.id, entryIds: ["entry-1"] },
    ]);
  });
});
