/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from "vitest";
import { act } from "@testing-library/react";
import { useCollectionMembership } from "@/lib/hooks/useCollectionMembership";
import { renderHookWithTrpc } from "../../../utils/component-test-helpers";

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

describe("useCollectionMembership.createWithEntry", () => {
  it("adds the entry to an existing collection the create returned (#1846)", async () => {
    const { result, callsFor } = renderHookWithTrpc(() => useCollectionMembership("entry-1"), {
      handlers: {
        "collections.listForEntry": () => ({ collectionIds: [] }),
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
