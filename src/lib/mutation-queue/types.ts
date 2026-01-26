/**
 * Mutation Queue Types
 *
 * Type definitions for the offline-capable mutation queue used by read/starred operations.
 * The queue stores mutations in IndexedDB and syncs them when online.
 */

/**
 * Entry type (web, email, saved).
 */
export type EntryType = "web" | "email" | "saved";

/**
 * Type of mutation operation.
 */
export type MutationType = "markRead" | "star" | "unstar";

/**
 * Entry context needed for cache updates after mutation completes.
 * This is captured when the mutation is queued so we can do optimistic updates
 * without needing to re-fetch entry data.
 */
export interface EntryContext {
  id: string;
  subscriptionId: string | null;
  starred: boolean;
  type: EntryType;
}

/**
 * A queued mutation waiting to be synced.
 */
export interface QueuedMutation {
  /**
   * Unique ID for this mutation (UUIDv7).
   */
  id: string;

  /**
   * Type of mutation operation.
   */
  type: MutationType;

  /**
   * Entry ID being mutated.
   */
  entryId: string;

  /**
   * Timestamp when the user performed the action.
   * Used for idempotency - server only applies if this is newer than existing state.
   */
  changedAt: Date;

  /**
   * Entry context for cache updates (captured at queue time).
   */
  entryContext: EntryContext;

  /**
   * For markRead mutations, whether to mark as read (true) or unread (false).
   */
  read?: boolean;

  /**
   * Number of times this mutation has been retried.
   */
  retryCount: number;

  /**
   * When this mutation was queued.
   */
  queuedAt: Date;

  /**
   * Status of the mutation.
   */
  status: "pending" | "processing" | "failed";

  /**
   * Last error message if failed.
   */
  lastError?: string;
}

/**
 * Stored mutation in IndexedDB.
 * Uses ISO date strings for serialization.
 */
export interface StoredMutation {
  id: string;
  type: MutationType;
  entryId: string;
  changedAt: string; // ISO date string
  entryContext: EntryContext;
  read?: boolean;
  retryCount: number;
  queuedAt: string; // ISO date string
  status: "pending" | "processing" | "failed";
  lastError?: string;
}

/**
 * Convert a QueuedMutation to StoredMutation for IndexedDB.
 */
export function toStoredMutation(mutation: QueuedMutation): StoredMutation {
  return {
    ...mutation,
    changedAt: mutation.changedAt.toISOString(),
    queuedAt: mutation.queuedAt.toISOString(),
  };
}

/**
 * Convert a StoredMutation from IndexedDB to QueuedMutation.
 */
export function fromStoredMutation(stored: StoredMutation): QueuedMutation {
  return {
    ...stored,
    changedAt: new Date(stored.changedAt),
    queuedAt: new Date(stored.queuedAt),
  };
}
