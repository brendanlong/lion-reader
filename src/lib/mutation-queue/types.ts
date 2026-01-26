/**
 * Mutation Queue Types
 *
 * Type definitions for the offline-capable mutation queue used by read/starred operations.
 * The queue stores mutations in IndexedDB and syncs them when online via Background Sync.
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
 * Entry context needed for optimistic cache updates.
 * Captured when the mutation is queued so we can update counts immediately.
 */
export interface EntryContext {
  id: string;
  subscriptionId: string | null;
  starred: boolean;
  read: boolean;
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
  changedAt: string; // ISO date string for serialization across worker boundary

  /**
   * Entry context for optimistic cache updates.
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
  queuedAt: string; // ISO date string

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
 * Message sent from main thread to service worker to queue a mutation.
 */
export interface MutationQueueMessage {
  type: "QUEUE_MUTATION";
  mutation: QueuedMutation;
}

/**
 * Message sent from service worker to main thread when a mutation completes.
 */
export interface MutationResultMessage {
  type: "MUTATION_RESULT";
  mutationId: string;
  success: boolean;
  error?: string;
  /**
   * Server response data for cache updates (only on success).
   */
  result?: {
    entries?: Array<{
      id: string;
      subscriptionId: string | null;
      starred: boolean;
      type: EntryType;
    }>;
    entry?: { id: string; read: boolean };
  };
}

/**
 * Message sent from service worker to main thread with queue status updates.
 */
export interface MutationQueueStatusMessage {
  type: "MUTATION_QUEUE_STATUS";
  pendingCount: number;
  isSyncing: boolean;
}

/**
 * Union type for all service worker messages.
 */
export type ServiceWorkerMessage =
  | MutationQueueMessage
  | MutationResultMessage
  | MutationQueueStatusMessage;
