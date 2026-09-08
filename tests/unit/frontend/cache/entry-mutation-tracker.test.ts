/**
 * Tests for EntryMutationTracker — the pure bookkeeping behind
 * useEntryMutations' optimistic read/starred updates. See the module header
 * for the contract (every start is settled exactly once; the newest server
 * updatedAt wins; nothing is handed back until every in-flight mutation for
 * the entry has settled).
 */

import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { EntryMutationTracker, getEntryMutationTracker } from "@/lib/cache/entry-mutation-tracker";

const t1 = new Date("2026-07-05T00:00:01.000Z");
const t2 = new Date("2026-07-05T00:00:02.000Z");

describe("EntryMutationTracker", () => {
  it("settles a single successful mutation with its own state", () => {
    const tracker = new EntryMutationTracker();
    tracker.start("e1", { read: false, starred: false });
    tracker.recordSuccess("e1", { read: true, starred: false, updatedAt: t1 });

    expect(tracker.settle("e1")).toEqual({
      kind: "apply",
      state: { read: true, starred: false, updatedAt: t1 },
    });
    expect(tracker.hasPending("e1")).toBe(false);
  });

  it("holds back the result until every in-flight mutation has settled", () => {
    const tracker = new EntryMutationTracker();
    tracker.start("e1", { read: false, starred: false });
    tracker.start("e1", { read: true, starred: true }); // ignored: not the first

    tracker.recordSuccess("e1", { read: true, starred: false, updatedAt: t1 });
    expect(tracker.settle("e1")).toBeNull();
    expect(tracker.hasPending("e1")).toBe(true);

    tracker.recordSuccess("e1", { read: false, starred: false, updatedAt: t2 });
    expect(tracker.settle("e1")).toEqual({
      kind: "apply",
      state: { read: false, starred: false, updatedAt: t2 },
    });
  });

  it("picks the newest updatedAt regardless of completion order", () => {
    const tracker = new EntryMutationTracker();
    tracker.start("e1", { read: false, starred: false });
    tracker.start("e1", { read: false, starred: false });

    // The later write's response lands first.
    tracker.recordSuccess("e1", { read: false, starred: false, updatedAt: t2 });
    tracker.settle("e1");
    tracker.recordSuccess("e1", { read: true, starred: false, updatedAt: t1 });

    expect(tracker.settle("e1")).toEqual({
      kind: "apply",
      state: { read: false, starred: false, updatedAt: t2 },
    });
  });

  it("rolls back to the state before the first mutation when every mutation fails", () => {
    const tracker = new EntryMutationTracker();
    tracker.start("e1", { read: true, starred: true });
    tracker.start("e1", { read: false, starred: true });

    expect(tracker.settle("e1")).toBeNull();
    expect(tracker.settle("e1")).toEqual({
      kind: "rollback",
      state: { read: true, starred: true },
    });
  });

  it("applies the successful mutation's state when only some mutations fail", () => {
    const tracker = new EntryMutationTracker();
    tracker.start("e1", { read: false, starred: false });
    tracker.start("e1", { read: false, starred: false });

    tracker.recordSuccess("e1", { read: false, starred: true, updatedAt: t1 });
    tracker.settle("e1");

    expect(tracker.settle("e1")).toEqual({
      kind: "apply",
      state: { read: false, starred: true, updatedAt: t1 },
    });
  });

  it("rolls back to undefined when the entry was in no cache", () => {
    const tracker = new EntryMutationTracker();
    tracker.start("e1", undefined);
    expect(tracker.settle("e1")).toEqual({ kind: "rollback", state: undefined });
  });

  it("tracks entries independently", () => {
    const tracker = new EntryMutationTracker();
    tracker.start("e1", { read: false, starred: false });
    tracker.start("e2", { read: false, starred: false });
    tracker.recordSuccess("e1", { read: true, starred: false, updatedAt: t1 });

    expect(tracker.settle("e1")?.kind).toBe("apply");
    expect(tracker.hasPending("e2")).toBe(true);
    expect(tracker.settle("e2")?.kind).toBe("rollback");
  });

  it("throws on recordSuccess or settle for an entry with no in-flight mutation", () => {
    const tracker = new EntryMutationTracker();
    expect(() =>
      tracker.recordSuccess("e1", { read: true, starred: false, updatedAt: t1 })
    ).toThrow(/e1/);
    expect(() => tracker.settle("e1")).toThrow(/e1/);

    tracker.start("e1", undefined);
    tracker.settle("e1");
    expect(() => tracker.settle("e1")).toThrow(/e1/);
  });
});

describe("getEntryMutationTracker", () => {
  it("returns one tracker per QueryClient", () => {
    const a = new QueryClient();
    const b = new QueryClient();
    expect(getEntryMutationTracker(a)).toBe(getEntryMutationTracker(a));
    expect(getEntryMutationTracker(a)).not.toBe(getEntryMutationTracker(b));
  });
});
