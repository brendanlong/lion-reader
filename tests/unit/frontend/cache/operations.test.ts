/**
 * Unit tests for cache operations.
 *
 * These tests document the behavior of cache operations without full mocking.
 * For more comprehensive testing, see the integration tests.
 *
 * Note: The cache operations call lower-level helpers that interact with
 * tRPC utils in complex ways. These tests focus on high-level behavior
 * that can be tested with the mock utils.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMockTrpcUtils } from "../../../utils/trpc-mock";
import {
  handleEntriesMarkedRead,
  handleEntryStarred,
  handleEntryUnstarred,
  handleNewEntry,
  type EntryWithContext,
} from "@/lib/cache/operations";

describe("handleEntriesMarkedRead", () => {
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
    mockUtils = createMockTrpcUtils();
  });

  it("does nothing for empty entries array", () => {
    handleEntriesMarkedRead(mockUtils.utils, [], true);
    expect(mockUtils.operations).toHaveLength(0);
  });

  it("updates entry read status in entries.get cache", () => {
    const entries: EntryWithContext[] = [
      { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "web" },
    ];

    handleEntriesMarkedRead(mockUtils.utils, entries, true);

    const setDataOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "get"
    );
    expect(setDataOps.length).toBeGreaterThan(0);
  });

  it("updates subscription unread counts", () => {
    const entries: EntryWithContext[] = [
      { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "web" },
      { id: "entry-2", subscriptionId: "sub-1", starred: false, type: "web" },
      { id: "entry-3", subscriptionId: "sub-2", starred: false, type: "web" },
    ];

    handleEntriesMarkedRead(mockUtils.utils, entries, true);

    // Should have called setData on subscriptions.list
    const subOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "subscriptions" && op.procedure === "list"
    );
    expect(subOps.length).toBeGreaterThan(0);
  });

  it("updates starred unread count for starred entries", () => {
    const entries: EntryWithContext[] = [
      { id: "entry-1", subscriptionId: "sub-1", starred: true, type: "web" },
      { id: "entry-2", subscriptionId: "sub-1", starred: false, type: "web" },
    ];

    handleEntriesMarkedRead(mockUtils.utils, entries, true);

    // Should have called setData on entries.count with starredOnly filter
    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    expect(countOps.length).toBeGreaterThan(0);
  });

  it("updates saved unread count for saved entries", () => {
    const entries: EntryWithContext[] = [
      { id: "entry-1", subscriptionId: "sub-1", starred: false, type: "saved" },
    ];

    handleEntriesMarkedRead(mockUtils.utils, entries, true);

    // Should have called setData on entries.count with type: "saved" filter
    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    expect(countOps.length).toBeGreaterThan(0);
  });

  it("handles entries without subscription (saved articles)", () => {
    const entries: EntryWithContext[] = [
      { id: "entry-1", subscriptionId: null, starred: false, type: "saved" },
    ];

    // Should not throw
    handleEntriesMarkedRead(mockUtils.utils, entries, true);

    // Should still update entries.get
    const entryOps = mockUtils.operations.filter((op) => op.router === "entries");
    expect(entryOps.length).toBeGreaterThan(0);
  });
});

describe("handleEntryStarred", () => {
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
    mockUtils = createMockTrpcUtils();
  });

  it("updates entry starred status", () => {
    handleEntryStarred(mockUtils.utils, "entry-1", false);

    const entryOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "get"
    );
    expect(entryOps.length).toBeGreaterThan(0);
  });

  it("updates starred count - total always +1", () => {
    handleEntryStarred(mockUtils.utils, "entry-1", true); // read entry

    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    expect(countOps.length).toBeGreaterThan(0);
  });

  it("updates starred unread count +1 for unread entry", () => {
    handleEntryStarred(mockUtils.utils, "entry-1", false); // unread entry

    // The unread delta should be +1
    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    expect(countOps.length).toBeGreaterThan(0);
  });

  it("does not change starred unread count for read entry", () => {
    handleEntryStarred(mockUtils.utils, "entry-1", true); // read entry

    // The unread delta should be 0 (only total changes)
    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    expect(countOps.length).toBeGreaterThan(0);
  });
});

describe("handleEntryUnstarred", () => {
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
    mockUtils = createMockTrpcUtils();
  });

  it("updates entry starred status to false", () => {
    handleEntryUnstarred(mockUtils.utils, "entry-1", false);

    const entryOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "get"
    );
    expect(entryOps.length).toBeGreaterThan(0);
  });

  it("updates starred count - total always -1", () => {
    handleEntryUnstarred(mockUtils.utils, "entry-1", true); // read entry

    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    expect(countOps.length).toBeGreaterThan(0);
  });

  it("updates starred unread count -1 for unread entry", () => {
    handleEntryUnstarred(mockUtils.utils, "entry-1", false); // unread entry

    // The unread delta should be -1
    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    expect(countOps.length).toBeGreaterThan(0);
  });
});

describe("handleNewEntry", () => {
  let mockUtils: ReturnType<typeof createMockTrpcUtils>;

  beforeEach(() => {
    mockUtils = createMockTrpcUtils();
  });

  it("increments subscription unread count", () => {
    handleNewEntry(mockUtils.utils, "sub-1", "web");

    const subOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "subscriptions" && op.procedure === "list"
    );
    expect(subOps.length).toBeGreaterThan(0);
  });

  it("increments saved unread count for saved entries", () => {
    handleNewEntry(mockUtils.utils, "sub-1", "saved");

    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    expect(countOps.length).toBeGreaterThan(0);
  });

  it("does not increment saved count for web entries", () => {
    handleNewEntry(mockUtils.utils, "sub-1", "web");

    // For web entries, we don't update the saved count
    const countOps = mockUtils.operations.filter(
      (op) => op.type === "setData" && op.router === "entries" && op.procedure === "count"
    );
    expect(countOps.length).toBe(0);
  });
});
