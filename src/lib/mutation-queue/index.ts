/**
 * Mutation Queue Module
 *
 * Provides offline-capable mutation queuing for read/starred operations.
 * Mutations are stored in IndexedDB and synced when online via Background Sync.
 */

export type {
  QueuedMutation,
  MutationType,
  EntryType,
  EntryContext,
  MutationQueueMessage,
  MutationResultMessage,
  MutationQueueStatusMessage,
  ServiceWorkerMessage,
} from "./types";
export { MutationQueueStore, MAX_RETRIES } from "./store";
