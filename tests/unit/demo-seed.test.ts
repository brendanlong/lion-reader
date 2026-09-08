/**
 * The demo's SSR seed (`buildDemoDehydratedState`) must hand the reader tree
 * exactly the cache it would have after mounting on that URL — the lists the
 * tree queries, and the open entry already marked read (with its list row
 * patched, as the auto-mark-read mutation does) so nothing flips on hydration.
 */

import { describe, expect, it } from "vitest";
import superjson from "superjson";
import { buildDemoDehydratedState } from "@/app/(public)/demo/seed";
import { createDemoStore } from "@/app/(public)/demo/store";
import { DEMO_ENTRIES } from "@/app/(public)/demo/data";

type Query = { queryKey: unknown; state: { data: unknown } };

function seeded(pathname: string, search: string) {
  const store = createDemoStore();
  const state = buildDemoDehydratedState(store, { pathname, search });
  const byPath = new Map<string, unknown>();
  for (const query of state.queries as Query[]) {
    const key = query.queryKey as [string[], { input?: unknown; type?: string }?];
    const id = `${key[0].join(".")}${key[1]?.type === "infinite" ? ":infinite" : ""}:${JSON.stringify(key[1]?.input ?? null)}`;
    byPath.set(id, superjson.deserialize(query.state.data as never));
  }
  return { store, byPath };
}

describe("buildDemoDehydratedState", () => {
  it("seeds the sidebar queries and the route's list for a list page", () => {
    const { byPath } = seeded("/tag/features", "");
    expect(byPath.get("entries.count:{}")).toEqual({ unread: DEMO_ENTRIES.length });
    expect(byPath.get("tags.list:null")).toMatchObject({ items: expect.any(Array) });
    expect(byPath.get("summarization.isAvailable:null")).toEqual({ available: true });

    const listKey = [...byPath.keys()].find((k) => k.startsWith("entries.list:infinite:"))!;
    expect(listKey).toContain('"tagId":"features"');
    expect(listKey).toContain('"unreadOnly":true');
    const list = byPath.get(listKey) as {
      pages: { items: { id: string }[] }[];
      pageParams: unknown[];
    };
    expect(list.pageParams).toEqual([null]);
    expect(list.pages[0].items).toHaveLength(10);
    expect(list.pages[0].items.every((i) => i.id !== "welcome")).toBe(true);
  });

  it("seeds an open entry as already read, still present in the unread-only list", () => {
    const { store, byPath } = seeded("/all", "entry=welcome");

    expect(byPath.get('entries.get:{"id":"welcome"}')).toMatchObject({
      entry: { id: "welcome", read: true },
    });
    // Counts reflect the read (matching what the reader shows after mount)…
    expect(byPath.get("entries.count:{}")).toEqual({ unread: DEMO_ENTRIES.length - 1 });
    // …and the store itself was updated, so later queries agree.
    expect(store.procedures["entries.get"]({ id: "welcome" }).entry.read).toBe(true);

    const listKey = [...byPath.keys()].find((k) => k.startsWith("entries.list:infinite:"))!;
    const list = byPath.get(listKey) as { pages: { items: { id: string; read: boolean }[] }[] };
    expect(list.pages[0].items[0]).toMatchObject({ id: "welcome", read: true });
  });

  it("seeds the subscription for a subscription page", () => {
    const { byPath } = seeded("/subscription/organization", "");
    expect(byPath.get('subscriptions.get:{"id":"organization"}')).toMatchObject({
      title: "Organization & Search",
    });
  });
});
