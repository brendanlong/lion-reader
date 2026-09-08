/**
 * The demo's in-memory backend (`createDemoStore`) implements the tRPC
 * procedures the reader tree issues, over the static article fixtures. These
 * tests pin the semantics the real store has and the cache layer relies on:
 * list filtering/sorting/pagination, the same-value re-assert rule for counts
 * (#1118), and the count shapes the mutations return.
 */

import { describe, expect, it } from "vitest";
import { createDemoStore } from "@/app/(public)/demo/store";
import {
  DEMO_ENTRIES,
  DEMO_SUBSCRIPTIONS,
  DEMO_TAGS,
  heroFigureHtml,
} from "@/app/(public)/demo/data";

const TOTAL = DEMO_ENTRIES.length;
const STARRED = DEMO_ENTRIES.filter((e) => e.starred).length;
const SAVED = DEMO_ENTRIES.filter((e) => e.type === "saved").length;

function listAll(procedures: ReturnType<typeof createDemoStore>["procedures"]) {
  const items = [];
  let cursor: string | undefined;
  do {
    const page = procedures["entries.list"]({ cursor, limit: 10 });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

describe("createDemoStore", () => {
  describe("entries.list", () => {
    it("starts with every article unread, newest first, welcome pinned to the top", () => {
      const { procedures } = createDemoStore();
      const items = listAll(procedures);
      expect(items).toHaveLength(TOTAL);
      expect(items[0].id).toBe("welcome");
      expect(items.every((item) => !item.read)).toBe(true);
      for (let i = 1; i < items.length; i++) {
        expect(items[i - 1].publishedAt!.getTime()).toBeGreaterThanOrEqual(
          items[i].publishedAt!.getTime()
        );
      }
    });

    it("paginates with an opaque cursor and reports the end of the list", () => {
      const { procedures } = createDemoStore();
      const first = procedures["entries.list"]({ limit: 10 });
      expect(first.items).toHaveLength(10);
      expect(first.nextCursor).toBeDefined();

      const second = procedures["entries.list"]({ limit: 10, cursor: first.nextCursor });
      expect(second.items[0].id).not.toBe(first.items[9].id);
      expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(20);

      const last = procedures["entries.list"]({ limit: 100, cursor: second.nextCursor });
      expect(last.nextCursor).toBeUndefined();
      expect(first.items.length + second.items.length + last.items.length).toBe(TOTAL);
    });

    it("filters by subscription, tag, type and starred", () => {
      const { procedures } = createDemoStore();
      const sub = DEMO_SUBSCRIPTIONS[0];
      const subItems = procedures["entries.list"]({ subscriptionId: sub.id, limit: 100 }).items;
      expect(subItems).toHaveLength(sub.entryCount);
      expect(subItems.every((i) => i.subscriptionId === sub.id)).toBe(true);

      const tag = DEMO_TAGS.find((t) => t.id === "features")!;
      const tagItems = procedures["entries.list"]({ tagId: tag.id, limit: 100 }).items;
      expect(tagItems.every((i) => tag.subscriptionIds.includes(i.subscriptionId!))).toBe(true);
      expect(tagItems.length).toBe(
        DEMO_ENTRIES.filter((e) => tag.subscriptionIds.includes(e.subscriptionId!)).length
      );

      expect(procedures["entries.list"]({ type: "saved", limit: 100 }).items).toHaveLength(SAVED);
      expect(procedures["entries.list"]({ starredOnly: true, limit: 100 }).items).toHaveLength(
        STARRED
      );
      // Query-string booleans are coerced like the router does.
      expect(procedures["entries.list"]({ starredOnly: "true", limit: 100 }).items).toHaveLength(
        STARRED
      );
    });

    it("searches title, summary and body text", () => {
      const { procedures } = createDemoStore();
      const hits = procedures["entries.list"]({
        query: "Welcome to Lion Reader",
        limit: 100,
      }).items;
      expect(hits.map((i) => i.id)).toContain("welcome");
      expect(procedures["entries.list"]({ query: "xyzzy-no-such-term", limit: 100 }).items).toEqual(
        []
      );
    });

    it("hides read entries in unread-only mode and lists them in recently-read order", () => {
      const { procedures } = createDemoStore();
      const t1 = new Date("2026-08-01T00:00:00Z");
      const t2 = new Date("2026-08-02T00:00:00Z");
      procedures["entries.markRead"]({ entries: [{ id: "opml", changedAt: t1 }], read: true });
      procedures["entries.markRead"]({ entries: [{ id: "tags", changedAt: t2 }], read: true });

      const unread = procedures["entries.list"]({ unreadOnly: true, limit: 100 }).items;
      expect(unread.map((i) => i.id)).not.toContain("opml");
      expect(unread).toHaveLength(TOTAL - 2);

      const recent = procedures["entries.list"]({ sortBy: "readChanged", limit: 100 }).items;
      expect(recent.map((i) => i.id)).toEqual(["tags", "opml"]);
    });
  });

  describe("read state and counts", () => {
    it("returns absolute counts for every affected list when read actually flips", () => {
      const { procedures } = createDemoStore();
      const welcome = DEMO_ENTRIES.find((e) => e.id === "welcome")!;
      const result = procedures["entries.markRead"]({ entries: [{ id: "welcome" }], read: true });

      expect(result.entries).toEqual([
        expect.objectContaining({ id: "welcome", read: true, starred: true }),
      ]);
      expect(result.counts).toMatchObject({
        all: { unread: TOTAL - 1 },
        starred: { unread: STARRED - 1 },
        saved: { unread: SAVED },
        subscriptions: [{ id: welcome.subscriptionId, unread: expect.any(Number) }],
        tags: [{ id: "about", unread: expect.any(Number) }],
      });
      expect(procedures["entries.count"]({ starredOnly: true })).toEqual({ unread: STARRED - 1 });
    });

    it("omits counts on a same-value re-assert but still advances the read-changed time (#1118)", () => {
      const { procedures } = createDemoStore();
      const t1 = new Date("2026-08-01T00:00:00Z");
      const t2 = new Date("2026-08-02T00:00:00Z");
      procedures["entries.markRead"]({ entries: [{ id: "welcome", changedAt: t1 }], read: true });
      procedures["entries.markRead"]({ entries: [{ id: "opml", changedAt: t1 }], read: true });
      const before = procedures["entries.get"]({ id: "welcome" }).entry.updatedAt;

      const result = procedures["entries.markRead"]({
        entries: [{ id: "welcome", changedAt: t2 }],
        read: true,
      });

      expect(result.counts).toBeUndefined();
      expect(procedures["entries.get"]({ id: "welcome" }).entry.updatedAt).toEqual(before);
      // The re-assert moved welcome to the top of Recently Read.
      expect(
        procedures["entries.list"]({ sortBy: "readChanged", limit: 100 }).items.map((i) => i.id)
      ).toEqual(["welcome", "opml"]);
    });

    it("marks all entries in a scope read", () => {
      const { procedures } = createDemoStore();
      const sub = DEMO_SUBSCRIPTIONS[0];
      expect(procedures["entries.markAllRead"]({ subscriptionId: sub.id })).toEqual({
        count: sub.entryCount,
      });
      expect(procedures["entries.count"]({ subscriptionId: sub.id })).toEqual({ unread: 0 });
      expect(procedures["entries.count"]({})).toEqual({ unread: TOTAL - sub.entryCount });
    });
  });

  describe("starring", () => {
    it("flips the star and returns counts scoped to the entry's lists", () => {
      const { procedures } = createDemoStore();
      const result = procedures["entries.setStarred"]({ id: "opml", starred: true });
      expect(result.entry).toMatchObject({ id: "opml", starred: true, read: false });
      expect(result.counts).toMatchObject({
        starred: { unread: STARRED + 1 },
        subscription: { id: "organization" },
        tags: [{ id: "features", unread: expect.any(Number) }],
      });
      // Re-asserting the same value changes nothing and reports no counts.
      expect(
        procedures["entries.setStarred"]({ id: "opml", starred: true }).counts
      ).toBeUndefined();
    });
  });

  describe("subscriptions and tags", () => {
    it("lists tags with feed and unread counts", () => {
      const { procedures } = createDemoStore();
      const tags = procedures["tags.list"]();
      expect(tags.items.map((t) => t.id).sort()).toEqual(DEMO_TAGS.map((t) => t.id).sort());
      const features = tags.items.find((t) => t.id === "features")!;
      expect(features.feedCount).toBe(4);
      expect(features.unreadCount).toBe(
        DEMO_ENTRIES.filter((e) => e.subscriptionId !== "lion-reader").length
      );
      expect(tags.uncategorized).toEqual({ feedCount: 0, unreadCount: 0 });
    });

    it("lists the subscriptions of a tag, with their tags", () => {
      const { procedures } = createDemoStore();
      const about = procedures["subscriptions.list"]({ tagId: "about" });
      expect(about.items.map((s) => s.id)).toEqual(["lion-reader"]);
      expect(about.items[0].tags).toEqual([{ id: "about", name: "About", color: "#10b981" }]);
      expect(about.nextCursor).toBeUndefined();
    });

    it("renames and retags a subscription", () => {
      const { procedures } = createDemoStore();
      expect(
        procedures["subscriptions.update"]({ id: "organization", customTitle: "Tidy" }).title
      ).toBe("Tidy");
      expect(procedures["subscriptions.get"]({ id: "organization" }).originalTitle).toBe(
        "Organization & Search"
      );
      procedures["subscriptions.update"]({ id: "organization", customTitle: null });
      expect(procedures["subscriptions.get"]({ id: "organization" }).title).toBe(
        "Organization & Search"
      );

      procedures["subscriptions.setTags"]({ id: "organization", tagIds: [] });
      expect(procedures["tags.list"]().uncategorized.feedCount).toBe(1);
      expect(procedures["entries.list"]({ uncategorized: true, limit: 100 }).items.length).toBe(
        DEMO_ENTRIES.filter((e) => e.subscriptionId === "organization").length
      );
    });

    it("unsubscribing hides the feed and its unstarred entries and returns absolute counts", () => {
      const { procedures } = createDemoStore();
      const sub = DEMO_SUBSCRIPTIONS.find((s) => s.id === "lion-reader")!;
      const starredInSub = DEMO_ENTRIES.filter(
        (e) => e.subscriptionId === sub.id && e.starred
      ).length;

      const result = procedures["subscriptions.delete"]({ id: sub.id });
      expect(result.success).toBe(true);
      expect(result.counts).toMatchObject({
        all: { unread: TOTAL - sub.entryCount + starredInSub },
        subscriptions: [{ id: sub.id, unread: 0 }],
        tags: [{ id: "about", unread: 0 }],
      });
      expect(() => procedures["subscriptions.get"]({ id: sub.id })).toThrow(/not found/i);
      // Starred entries survive as orphans, like the app.
      const remaining = procedures["entries.list"]({ limit: 100 }).items;
      expect(remaining.filter((i) => i.subscriptionId === null)).toHaveLength(starredInSub);
      expect(procedures["tags.list"]().items.find((t) => t.id === "about")!.feedCount).toBe(0);
    });
  });

  describe("entries.get and summaries", () => {
    it("returns the full article with its hero figure and canned summary", () => {
      const { procedures } = createDemoStore();
      const welcome = DEMO_ENTRIES.find((e) => e.id === "welcome")!;
      const { entry } = procedures["entries.get"]({ id: "welcome" });
      // Next resolves the imported hero to a URL; under vitest the import is
      // opaque, so check the figure builder on a resolved entry separately.
      expect(entry.contentCleaned).toBe(heroFigureHtml(welcome) + welcome.contentHtml);
      expect(
        heroFigureHtml({ ...welcome, heroImage: "/hero.png", heroImageAlt: "The lion waving" })
      ).toBe(
        '<figure><img src="/hero.png" alt="The lion waving" width="1200" height="630" /></figure>\n'
      );
      expect(entry.contentCleaned).toContain("This interactive demo is the real Lion Reader UI");
      expect(entry.fetchFullContent).toBe(false);
      expect(entry.fullContentFetchedAt).toBeNull();

      const summary = procedures["summarization.generate"]({ entryId: "welcome" });
      expect(summary.summary).toContain("Lion Reader");
      expect(summary.modelId).toBe("claude-sonnet-5");
      expect(summary.settingsChanged).toBe(false);
    });

    it("errors with NOT_FOUND for an unknown id", () => {
      const { procedures } = createDemoStore();
      expect(() => procedures["entries.get"]({ id: "nope" })).toThrow(
        expect.objectContaining({ data: expect.objectContaining({ code: "NOT_FOUND" }) })
      );
    });

    it("hands back new objects each call so cached data can't be mutated behind the cache", () => {
      const { procedures } = createDemoStore();
      const a = procedures["entries.get"]({ id: "welcome" }).entry;
      const b = procedures["entries.get"]({ id: "welcome" }).entry;
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });
});
