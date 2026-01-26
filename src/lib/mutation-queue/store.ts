/**
 * Mutation Queue IndexedDB Store
 *
 * Provides persistent storage for offline mutations in IndexedDB.
 * Similar pattern to VoiceCache but for mutation operations.
 *
 * @module mutation-queue/store
 */

import type { QueuedMutation, StoredMutation } from "./types";
import { toStoredMutation, fromStoredMutation } from "./types";

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
 * synced when the app comes back online.
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
 *   changedAt: new Date(),
 *   entryContext: { ... },
 *   read: true,
 *   retryCount: 0,
 *   queuedAt: new Date(),
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
   */
  static isAvailable(): boolean {
    if (typeof window === "undefined") {
      return false;
    }
    return "indexedDB" in window && window.indexedDB !== null;
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
      const request = store.add(toStoredMutation(mutation));

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
      const request = store.put(toStoredMutation(mutation));

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
        const result = request.result as StoredMutation | undefined;
        resolve(result ? fromStoredMutation(result) : undefined);
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
        const results = (request.result as StoredMutation[]).map(fromStoredMutation);
        // Sort by queuedAt to process in order
        results.sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime());
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
        const results = (request.result as StoredMutation[]).map(fromStoredMutation);
        results.sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime());
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
        const results = (request.result as StoredMutation[])
          .map(fromStoredMutation)
          .filter((m) => m.status === "pending" || m.status === "processing");

        if (results.length === 0) {
          resolve(undefined);
          return;
        }

        // Return the most recent one by changedAt
        results.sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime());
        resolve(results[0]);
      };
    });
  }

  /**
   * Remove all mutations for an entry (used when superseded).
   */
  async removeAllForEntry(entryId: string): Promise<void> {
    const db = await this.openDatabase();
    const mutations = await this.getAll();
    const toRemove = mutations.filter((m) => m.entryId === entryId);

    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    return new Promise<void>((resolve, reject) => {
      let remaining = toRemove.length;
      if (remaining === 0) {
        resolve();
        return;
      }

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
