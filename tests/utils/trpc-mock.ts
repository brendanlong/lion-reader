/**
 * Mock utilities for tRPC cache operations testing.
 *
 * These mocks allow testing cache operations without a real tRPC client.
 */

import { vi } from "vitest";
import type { TRPCClientUtils } from "@/lib/trpc/client";

/**
 * Recorded cache operation for verification.
 */
export interface CacheOperation {
  type: "setData" | "getData" | "invalidate" | "cancel";
  router: string;
  procedure: string;
  input?: unknown;
  data?: unknown;
}

/**
 * Creates a mock TRPCClientUtils that records all cache operations.
 *
 * @example
 * ```ts
 * const { utils, operations, getCache, setCache } = createMockTrpcUtils();
 *
 * // Set up initial cache state
 * setCache("subscriptions.list", undefined, { items: [...] });
 *
 * // Call the function under test
 * handleEntriesMarkedRead(utils, entries, true);
 *
 * // Verify cache operations
 * expect(operations).toContainEqual({
 *   type: "setData",
 *   router: "entries",
 *   procedure: "get",
 *   input: { id: "entry-1" },
 *   data: expect.objectContaining({ read: true }),
 * });
 * ```
 */
export function createMockTrpcUtils() {
  const operations: CacheOperation[] = [];
  const cache = new Map<string, unknown>();

  function getCacheKey(router: string, procedure: string, input?: unknown): string {
    return `${router}.${procedure}:${JSON.stringify(input ?? null)}`;
  }

  function createProcedureMock(router: string, procedure: string) {
    return {
      setData: vi.fn((input: unknown, updater: unknown) => {
        const key = getCacheKey(router, procedure, input);
        const currentData = cache.get(key);
        const newData = typeof updater === "function" ? updater(currentData) : updater;
        cache.set(key, newData);
        operations.push({
          type: "setData",
          router,
          procedure,
          input,
          data: newData,
        });
      }),
      getData: vi.fn((input?: unknown) => {
        const key = getCacheKey(router, procedure, input);
        operations.push({
          type: "getData",
          router,
          procedure,
          input,
        });
        return cache.get(key);
      }),
      invalidate: vi.fn((input?: unknown) => {
        operations.push({
          type: "invalidate",
          router,
          procedure,
          input,
        });
        return Promise.resolve();
      }),
      cancel: vi.fn((input?: unknown) => {
        operations.push({
          type: "cancel",
          router,
          procedure,
          input,
        });
        return Promise.resolve();
      }),
    };
  }

  const utils = {
    entries: {
      get: createProcedureMock("entries", "get"),
      list: createProcedureMock("entries", "list"),
      count: createProcedureMock("entries", "count"),
    },
    subscriptions: {
      get: createProcedureMock("subscriptions", "get"),
      list: createProcedureMock("subscriptions", "list"),
    },
    tags: {
      list: createProcedureMock("tags", "list"),
    },
  } as unknown as TRPCClientUtils;

  return {
    utils,
    operations,
    /**
     * Get a value from the mock cache.
     */
    getCache: (router: string, procedure: string, input?: unknown) => {
      return cache.get(getCacheKey(router, procedure, input));
    },
    /**
     * Set a value in the mock cache (for test setup).
     */
    setCache: (router: string, procedure: string, input: unknown, data: unknown) => {
      cache.set(getCacheKey(router, procedure, input), data);
    },
    /**
     * Clear all recorded operations (for resetting between test cases).
     */
    clearOperations: () => {
      operations.length = 0;
    },
    /**
     * Clear the entire cache.
     */
    clearCache: () => {
      cache.clear();
    },
  };
}
