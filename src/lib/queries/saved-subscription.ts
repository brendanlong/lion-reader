/**
 * The `subscriptions.list` input the app always loads to learn the user's
 * saved subscription (#1846), shared by the server prefetch and the client
 * hook (`useSavedSubscriptionId`) so their cache keys match.
 *
 * Saved is a membership like a collection: an entry is in the Saved list when
 * its `subscriptionIds` hold the saved subscription's id, whatever its `type`.
 * No sidebar section lists the saved subscription (it's in no tag or
 * Uncategorized), so this lists it alone: empty until the first save creates
 * it. The local store keeps its id as `LocalDb.saved`.
 */
export const SAVED_SUBSCRIPTION_LIST_INPUT = { type: "saved", limit: 1 } as const;
