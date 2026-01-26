/**
 * Mutation Queue Module
 *
 * Provides offline-capable mutation queuing for read/starred operations.
 * Mutations are stored in IndexedDB and synced when online.
 */

export type { QueuedMutation, MutationType, EntryContext, StoredMutation } from "./types";
export { toStoredMutation, fromStoredMutation } from "./types";
export { MutationQueueStore, MAX_RETRIES } from "./store";
