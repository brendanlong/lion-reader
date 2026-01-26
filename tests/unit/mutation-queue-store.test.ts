/**
 * Unit tests for MutationQueueStore IndexedDB storage.
 *
 * These tests use fake-indexeddb to simulate IndexedDB in Node.js.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { indexedDB } from "fake-indexeddb";

// Set up globals BEFORE importing the module under test
// This must be done at module level because imports are hoisted
vi.stubGlobal("window", { indexedDB });
vi.stubGlobal("indexedDB", indexedDB);

import { MutationQueueStore, MAX_RETRIES, type QueuedMutation } from "../../src/lib/mutation-queue";

/**
 * Helper to create a test mutation.
 */
function createTestMutation(overrides: Partial<QueuedMutation> = {}): QueuedMutation {
  return {
    id: `mutation-${Date.now()}-${Math.random()}`,
    type: "markRead",
    entryId: "entry-123",
    changedAt: new Date(),
    entryContext: {
      id: "entry-123",
      subscriptionId: "sub-456",
      starred: false,
      type: "web",
    },
    read: true,
    retryCount: 0,
    queuedAt: new Date(),
    status: "pending",
    ...overrides,
  };
}

describe("MutationQueueStore", () => {
  let store: MutationQueueStore;

  beforeEach(async () => {
    store = new MutationQueueStore();
  });

  afterEach(async () => {
    // Clean up the database after each test
    await store.clear();
    store.close();
  });

  describe("isAvailable", () => {
    it("returns true when indexedDB is available", () => {
      expect(MutationQueueStore.isAvailable()).toBe(true);
    });

    it("returns false when window is undefined", () => {
      const stubbedWindow = global.window;
      // @ts-expect-error - Intentionally setting to undefined for testing
      global.window = undefined;

      expect(MutationQueueStore.isAvailable()).toBe(false);

      global.window = stubbedWindow;
    });
  });

  describe("add and get", () => {
    it("adds and retrieves a mutation", async () => {
      const mutation = createTestMutation({ id: "test-mutation-1" });

      await store.add(mutation);
      const retrieved = await store.get("test-mutation-1");

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe("test-mutation-1");
      expect(retrieved?.type).toBe("markRead");
      expect(retrieved?.entryId).toBe("entry-123");
      expect(retrieved?.read).toBe(true);
    });

    it("returns undefined for non-existent mutation", async () => {
      const result = await store.get("non-existent");
      expect(result).toBeUndefined();
    });

    it("preserves date fields correctly", async () => {
      const changedAt = new Date("2024-01-15T10:30:00Z");
      const queuedAt = new Date("2024-01-15T10:30:01Z");
      const mutation = createTestMutation({
        id: "date-test",
        changedAt,
        queuedAt,
      });

      await store.add(mutation);
      const retrieved = await store.get("date-test");

      expect(retrieved?.changedAt).toBeInstanceOf(Date);
      expect(retrieved?.queuedAt).toBeInstanceOf(Date);
      expect(retrieved?.changedAt.toISOString()).toBe(changedAt.toISOString());
      expect(retrieved?.queuedAt.toISOString()).toBe(queuedAt.toISOString());
    });

    it("stores multiple mutations", async () => {
      const mutations = [
        createTestMutation({ id: "mut-1", entryId: "entry-1" }),
        createTestMutation({ id: "mut-2", entryId: "entry-2" }),
        createTestMutation({ id: "mut-3", entryId: "entry-3" }),
      ];

      for (const m of mutations) {
        await store.add(m);
      }

      const all = await store.getAll();
      expect(all).toHaveLength(3);
    });
  });

  describe("update", () => {
    it("updates an existing mutation", async () => {
      const mutation = createTestMutation({ id: "update-test" });
      await store.add(mutation);

      const updated = { ...mutation, retryCount: 3, lastError: "Network error" };
      await store.update(updated);

      const retrieved = await store.get("update-test");
      expect(retrieved?.retryCount).toBe(3);
      expect(retrieved?.lastError).toBe("Network error");
    });

    it("updates status from pending to processing", async () => {
      const mutation = createTestMutation({ id: "status-test", status: "pending" });
      await store.add(mutation);

      await store.update({ ...mutation, status: "processing" });

      const retrieved = await store.get("status-test");
      expect(retrieved?.status).toBe("processing");
    });
  });

  describe("remove", () => {
    it("removes a mutation", async () => {
      const mutation = createTestMutation({ id: "remove-test" });
      await store.add(mutation);

      await store.remove("remove-test");

      const retrieved = await store.get("remove-test");
      expect(retrieved).toBeUndefined();
    });

    it("does not throw when removing non-existent mutation", async () => {
      await expect(store.remove("non-existent")).resolves.not.toThrow();
    });

    it("does not affect other mutations", async () => {
      const mutation1 = createTestMutation({ id: "mut-1" });
      const mutation2 = createTestMutation({ id: "mut-2" });
      await store.add(mutation1);
      await store.add(mutation2);

      await store.remove("mut-1");

      const retrieved1 = await store.get("mut-1");
      const retrieved2 = await store.get("mut-2");
      expect(retrieved1).toBeUndefined();
      expect(retrieved2).toBeDefined();
    });
  });

  describe("getPending", () => {
    it("returns empty array when no mutations", async () => {
      const pending = await store.getPending();
      expect(pending).toEqual([]);
    });

    it("returns only pending mutations", async () => {
      await store.add(createTestMutation({ id: "pending-1", status: "pending" }));
      await store.add(createTestMutation({ id: "processing-1", status: "processing" }));
      await store.add(createTestMutation({ id: "failed-1", status: "failed" }));
      await store.add(createTestMutation({ id: "pending-2", status: "pending" }));

      const pending = await store.getPending();

      expect(pending).toHaveLength(2);
      const ids = pending.map((m) => m.id);
      expect(ids).toContain("pending-1");
      expect(ids).toContain("pending-2");
      expect(ids).not.toContain("processing-1");
      expect(ids).not.toContain("failed-1");
    });

    it("returns mutations sorted by queuedAt", async () => {
      const earlier = new Date("2024-01-15T10:00:00Z");
      const later = new Date("2024-01-15T11:00:00Z");
      const latest = new Date("2024-01-15T12:00:00Z");

      await store.add(createTestMutation({ id: "later", queuedAt: later, status: "pending" }));
      await store.add(createTestMutation({ id: "latest", queuedAt: latest, status: "pending" }));
      await store.add(createTestMutation({ id: "earlier", queuedAt: earlier, status: "pending" }));

      const pending = await store.getPending();

      expect(pending[0].id).toBe("earlier");
      expect(pending[1].id).toBe("later");
      expect(pending[2].id).toBe("latest");
    });
  });

  describe("getAll", () => {
    it("returns all mutations regardless of status", async () => {
      await store.add(createTestMutation({ id: "pending-1", status: "pending" }));
      await store.add(createTestMutation({ id: "processing-1", status: "processing" }));
      await store.add(createTestMutation({ id: "failed-1", status: "failed" }));

      const all = await store.getAll();

      expect(all).toHaveLength(3);
    });

    it("returns mutations sorted by queuedAt", async () => {
      const earlier = new Date("2024-01-15T10:00:00Z");
      const later = new Date("2024-01-15T11:00:00Z");

      await store.add(createTestMutation({ id: "later", queuedAt: later }));
      await store.add(createTestMutation({ id: "earlier", queuedAt: earlier }));

      const all = await store.getAll();

      expect(all[0].id).toBe("earlier");
      expect(all[1].id).toBe("later");
    });
  });

  describe("getLatestForEntry", () => {
    it("returns undefined when no mutations for entry", async () => {
      const result = await store.getLatestForEntry("non-existent-entry");
      expect(result).toBeUndefined();
    });

    it("returns the most recent mutation for an entry", async () => {
      const earlier = new Date("2024-01-15T10:00:00Z");
      const later = new Date("2024-01-15T11:00:00Z");

      await store.add(
        createTestMutation({
          id: "mut-1",
          entryId: "entry-x",
          changedAt: earlier,
          read: true,
        })
      );
      await store.add(
        createTestMutation({
          id: "mut-2",
          entryId: "entry-x",
          changedAt: later,
          read: false,
        })
      );

      const latest = await store.getLatestForEntry("entry-x");

      expect(latest?.id).toBe("mut-2");
      expect(latest?.read).toBe(false);
    });

    it("ignores failed mutations", async () => {
      await store.add(
        createTestMutation({
          id: "failed-mut",
          entryId: "entry-x",
          changedAt: new Date("2024-01-15T12:00:00Z"),
          status: "failed",
        })
      );
      await store.add(
        createTestMutation({
          id: "pending-mut",
          entryId: "entry-x",
          changedAt: new Date("2024-01-15T10:00:00Z"),
          status: "pending",
        })
      );

      const latest = await store.getLatestForEntry("entry-x");

      expect(latest?.id).toBe("pending-mut");
    });
  });

  describe("removeAllForEntry", () => {
    it("removes all mutations for a specific entry", async () => {
      await store.add(createTestMutation({ id: "mut-1", entryId: "entry-x" }));
      await store.add(createTestMutation({ id: "mut-2", entryId: "entry-x" }));
      await store.add(createTestMutation({ id: "mut-3", entryId: "entry-y" }));

      await store.removeAllForEntry("entry-x");

      const all = await store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].entryId).toBe("entry-y");
    });

    it("does nothing when entry has no mutations", async () => {
      await store.add(createTestMutation({ id: "mut-1", entryId: "entry-x" }));

      await store.removeAllForEntry("non-existent");

      const all = await store.getAll();
      expect(all).toHaveLength(1);
    });
  });

  describe("clear", () => {
    it("removes all mutations", async () => {
      await store.add(createTestMutation({ id: "mut-1" }));
      await store.add(createTestMutation({ id: "mut-2" }));
      await store.add(createTestMutation({ id: "mut-3" }));

      await store.clear();

      const all = await store.getAll();
      expect(all).toHaveLength(0);
    });
  });

  describe("getPendingCount", () => {
    it("returns 0 when no mutations", async () => {
      const count = await store.getPendingCount();
      expect(count).toBe(0);
    });

    it("counts only pending mutations", async () => {
      await store.add(createTestMutation({ id: "pending-1", status: "pending" }));
      await store.add(createTestMutation({ id: "pending-2", status: "pending" }));
      await store.add(createTestMutation({ id: "processing-1", status: "processing" }));
      await store.add(createTestMutation({ id: "failed-1", status: "failed" }));

      const count = await store.getPendingCount();
      expect(count).toBe(2);
    });
  });

  describe("mutation types", () => {
    it("stores markRead mutations correctly", async () => {
      const mutation = createTestMutation({
        id: "mark-read",
        type: "markRead",
        read: true,
      });
      await store.add(mutation);

      const retrieved = await store.get("mark-read");
      expect(retrieved?.type).toBe("markRead");
      expect(retrieved?.read).toBe(true);
    });

    it("stores star mutations correctly", async () => {
      const mutation = createTestMutation({
        id: "star",
        type: "star",
        read: undefined,
      });
      await store.add(mutation);

      const retrieved = await store.get("star");
      expect(retrieved?.type).toBe("star");
      expect(retrieved?.read).toBeUndefined();
    });

    it("stores unstar mutations correctly", async () => {
      const mutation = createTestMutation({
        id: "unstar",
        type: "unstar",
        read: undefined,
      });
      await store.add(mutation);

      const retrieved = await store.get("unstar");
      expect(retrieved?.type).toBe("unstar");
    });
  });

  describe("entry context", () => {
    it("preserves full entry context", async () => {
      const mutation = createTestMutation({
        id: "context-test",
        entryContext: {
          id: "entry-123",
          subscriptionId: "sub-456",
          starred: true,
          type: "email",
        },
      });
      await store.add(mutation);

      const retrieved = await store.get("context-test");
      expect(retrieved?.entryContext).toEqual({
        id: "entry-123",
        subscriptionId: "sub-456",
        starred: true,
        type: "email",
      });
    });

    it("handles null subscriptionId", async () => {
      const mutation = createTestMutation({
        id: "null-sub-test",
        entryContext: {
          id: "entry-123",
          subscriptionId: null,
          starred: false,
          type: "saved",
        },
      });
      await store.add(mutation);

      const retrieved = await store.get("null-sub-test");
      expect(retrieved?.entryContext.subscriptionId).toBeNull();
    });
  });

  describe("MAX_RETRIES constant", () => {
    it("equals 5", () => {
      expect(MAX_RETRIES).toBe(5);
    });
  });

  describe("close", () => {
    it("allows closing without error", async () => {
      await store.getAll();
      expect(() => store.close()).not.toThrow();
    });

    it("allows closing when never opened", () => {
      const freshStore = new MutationQueueStore();
      expect(() => freshStore.close()).not.toThrow();
    });
  });
});
