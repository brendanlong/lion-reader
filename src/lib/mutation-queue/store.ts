/**
 * Mutation Queue IndexedDB Store
 *
 * Provides persistent storage for offline mutations in IndexedDB.
 * Used by both the main thread and service worker.
 *
 * @module mutation-queue/store
 */

import type { QueuedMutation } from "./types";

/**
 * Database name for mutation queue storage.
 */
const DB_NAME = "lion-reader-mutation-queue";

/**
 * Object store name for mutations.
 */
const STORE_NAME = "mutations";

/**
 * Current database version.
 */
const DB_VERSION = 1;

/**
 * Maximum number of retries before marking a mutation as failed.
 */
export const MAX_RETRIES = 5;

/**
 * Class for managing mutation queue in IndexedDB.
 *
 * Provides persistent storage for read/starred mutations that can be
 * synced when the app comes back online via Background Sync.
 *
 * @example
 * ```ts
 * const store = new MutationQueueStore();
 *
 * // Add a mutation
 * await store.add({
 *   id: "uuid",
 *   type: "markRead",
 *   entryId: "entry-uuid",
 *   changedAt: new Date().toISOString(),
 *   entryContext: { id: "...", subscriptionId: "...", starred: false, read: false, type: "web" },
 *   read: true,
 *   retryCount: 0,
 *   queuedAt: new Date().toISOString(),
 *   status: "pending",
 * });
 *
 * // Get pending mutations
 * const pending = await store.getPending();
 * ```
 */
export class MutationQueueStore {
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * Checks if IndexedDB is available in the current environment.
   * Works in both main thread and service worker.
   */
  static isAvailable(): boolean {
    // In service worker, use self.indexedDB
    if (typeof self !== "undefined" && "indexedDB" in self) {
      return true;
    }
    // In main thread, check window
    if (typeof window !== "undefined" && "indexedDB" in window) {
      return true;
    }
    return false;
  }

  /**
   * Opens or creates the IndexedDB database.
   */
  private async openDatabase(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }

    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (!MutationQueueStore.isAvailable()) {
        reject(new Error("IndexedDB is not available"));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        this.dbPromise = null;
        reject(new Error(`Failed to open IndexedDB: ${request.error?.message ?? "Unknown error"}`));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          // Index by status for efficient pending lookup
          store.createIndex("status", "status", { unique: false });
          // Index by entryId for deduplication/lookup
          store.createIndex("entryId", "entryId", { unique: false });
          // Compound index for finding pending mutations by entry
          store.createIndex("entryId_status", ["entryId", "status"], { unique: false });
        }
      };
    });

    return this.dbPromise;
  }

  /**
   * Add a mutation to the queue.
   */
  async add(mutation: QueuedMutation): Promise<void> {
    const db = await this.openDatabase();

    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.add(mutation);

      request.onerror = () => {
        reject(new Error(`Failed to add mutation: ${request.error?.message ?? "Unknown error"}`));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Update a mutation in the queue.
   */
  async update(mutation: QueuedMutation): Promise<void> {
    const db = await this.openDatabase();

    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(mutation);

      request.onerror = () => {
        reject(
          new Error(`Failed to update mutation: ${request.error?.message ?? "Unknown error"}`)
        );
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Remove a mutation from the queue.
   */
  async remove(id: string): Promise<void> {
    const db = await this.openDatabase();

    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(id);

      request.onerror = () => {
        reject(
          new Error(`Failed to remove mutation: ${request.error?.message ?? "Unknown error"}`)
        );
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Get a mutation by ID.
   */
  async get(id: string): Promise<QueuedMutation | undefined> {
    const db = await this.openDatabase();

    return new Promise<QueuedMutation | undefined>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);

      request.onerror = () => {
        reject(new Error(`Failed to get mutation: ${request.error?.message ?? "Unknown error"}`));
      };

      request.onsuccess = () => {
        resolve(request.result as QueuedMutation | undefined);
      };
    });
  }

  /**
   * Get all pending mutations, ordered by queuedAt.
   */
  async getPending(): Promise<QueuedMutation[]> {
    const db = await this.openDatabase();

    return new Promise<QueuedMutation[]>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("status");
      const request = index.getAll("pending");

      request.onerror = () => {
        reject(
          new Error(`Failed to get pending mutations: ${request.error?.message ?? "Unknown error"}`)
        );
      };

      request.onsuccess = () => {
        const results = request.result as QueuedMutation[];
        // Sort by queuedAt to process in order (string comparison works for ISO dates)
        results.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
        resolve(results);
      };
    });
  }

  /**
   * Get all mutations (for debugging/inspection).
   */
  async getAll(): Promise<QueuedMutation[]> {
    const db = await this.openDatabase();

    return new Promise<QueuedMutation[]>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onerror = () => {
        reject(
          new Error(`Failed to get all mutations: ${request.error?.message ?? "Unknown error"}`)
        );
      };

      request.onsuccess = () => {
        const results = request.result as QueuedMutation[];
        results.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
        resolve(results);
      };
    });
  }

  /**
   * Get the most recent mutation for an entry.
   * Used for optimistic UI - returns the latest queued state.
   */
  async getLatestForEntry(entryId: string): Promise<QueuedMutation | undefined> {
    const db = await this.openDatabase();

    return new Promise<QueuedMutation | undefined>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("entryId");
      const request = index.getAll(entryId);

      request.onerror = () => {
        reject(
          new Error(
            `Failed to get mutations for entry: ${request.error?.message ?? "Unknown error"}`
          )
        );
      };

      request.onsuccess = () => {
        const results = (request.result as QueuedMutation[]).filter(
          (m) => m.status === "pending" || m.status === "processing"
        );

        if (results.length === 0) {
          resolve(undefined);
          return;
        }

        // Return the most recent one by changedAt (string comparison works for ISO dates)
        results.sort((a, b) => b.changedAt.localeCompare(a.changedAt));
        resolve(results[0]);
      };
    });
  }

  /**
   * Remove all mutations for an entry (used when superseded by a new mutation).
   */
  async removeAllForEntry(entryId: string): Promise<void> {
    const db = await this.openDatabase();
    const mutations = await this.getAll();
    const toRemove = mutations.filter((m) => m.entryId === entryId);

    if (toRemove.length === 0) {
      return;
    }

    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    return new Promise<void>((resolve, reject) => {
      let remaining = toRemove.length;

      for (const mutation of toRemove) {
        const request = store.delete(mutation.id);
        request.onerror = () => {
          reject(
            new Error(`Failed to remove mutation: ${request.error?.message ?? "Unknown error"}`)
          );
        };
        request.onsuccess = () => {
          remaining--;
          if (remaining === 0) {
            resolve();
          }
        };
      }
    });
  }

  /**
   * Clear all mutations from the queue.
   */
  async clear(): Promise<void> {
    const db = await this.openDatabase();

    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onerror = () => {
        reject(new Error(`Failed to clear queue: ${request.error?.message ?? "Unknown error"}`));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Get count of pending mutations.
   */
  async getPendingCount(): Promise<number> {
    const db = await this.openDatabase();

    return new Promise<number>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("status");
      const request = index.count("pending");

      request.onerror = () => {
        reject(new Error(`Failed to count pending: ${request.error?.message ?? "Unknown error"}`));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.dbPromise = null;
  }
}
